# Callsign on ECS Fargate

Terraform for running `callsign-server` on AWS with managed, horizontally scalable services. For a single, much cheaper machine, see [`infra/aws-ec2`](../aws-ec2). The dashboard (`app.callsign.im`) and the website (`callsign.im`) are deployed on Vercel and are not managed here. DNS for `callsign.im` stays at Namecheap unless you point Terraform at a Route 53 zone.

## Architecture

- **Network**: a VPC across two availability zones with public subnets (load balancer, NAT gateway) and private subnets (tasks, database, cache). An S3 gateway endpoint keeps image pulls off the NAT gateway.
- **API**: an internet-facing Application Load Balancer at `api.callsign.im` (ACM certificate, TLS 1.3/1.2 policy, HTTP to HTTPS redirect, 120 s idle timeout for SSE) in front of an ECS Fargate service that autoscales on CPU.
- **Worker and migrations**: a Fargate worker service and a one-off migration task definition. The API, worker and migrations all run the same image with different commands.
- **Data**: RDS for PostgreSQL 17 and ElastiCache for Valkey, both private and encrypted at rest and in transit. RDS generates the master password and keeps it in Secrets Manager.
- **Application encryption**: a KMS key, `alias/callsign-<env>-data`, wraps the data keys that encrypt messages, ledger entries, contacts and rules before they are stored. Its policy lets administrators manage the key but only the tasks' role use it. See [docs/encryption.md](../../docs/encryption.md).
- **Images**: an ECR repository, `callsign-server`. Images are tagged with the git SHA, scanned on push, and expired by a lifecycle policy.
- **Email**: an SES domain identity with Easy DKIM plus SMTP credentials. You can use any other SMTP provider instead.
- **CI/CD**: a GitHub Actions OIDC role that can deploy from one repository and one GitHub environment, and nothing else.

### Runtime configuration

Terraform sets these variables on the containers:

| Variable | Source | Containers |
|---|---|---|
| `NODE_ENV`, `LOG_LEVEL` | `production`, `var.log_level` | all |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGSSLMODE` | RDS instance (`PGSSLMODE=require`) | all |
| `PGPASSWORD` | RDS-managed secret (`password` key) | all |
| `PORT` | `8080` | api |
| `REDIS_URL` | `rediss://<primary endpoint>:6379` | api, worker |
| `PUBLIC_API_URL`, `APP_URL`, `SITE_URL`, `MAIL_FROM` | `https://api.<domain>`, `var.app_url`, `var.site_url`, `var.mail_from` | api, worker |
| `SMTP_URL` | Secrets Manager (`callsign-<env>/smtp-url`) | api, worker |
| `KMS_KEY_ID` | The data key's ARN | api, worker |

## Prerequisites

- An AWS account, and credentials with administrator access for the first apply
- Terraform 1.10 or later, AWS CLI v2 and `jq`
- GitHub CLI (`gh`), optional, for setting workflow variables
- Access to the Namecheap DNS settings for `callsign.im`

## First-time setup

### 1. Create the state bucket

```sh
export AWS_REGION=us-east-1
BUCKET="callsign-terraform-state-$(aws sts get-caller-identity --query Account --output text)"

aws s3api create-bucket --bucket "$BUCKET" --region "$AWS_REGION"
# Outside us-east-1, also pass: --create-bucket-configuration LocationConstraint="$AWS_REGION"
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
```

New buckets block public access and encrypt objects by default. State locking uses S3 native lock files, so you don't need a DynamoDB table.

### 2. Configure

```sh
cd infra/aws-ecs
cp backend.tf.example backend.tf              # set the bucket name
cp terraform.tfvars.example terraform.tfvars  # set github_repository and review the defaults
terraform init
```

### 3. Issue the certificate and verify the domain

The HTTPS listener can't be created until ACM has issued the certificate. ACM won't issue it until its validation record exists in DNS. So create the certificate and the SES identity first:

```sh
terraform apply -target=aws_acm_certificate.api -target=aws_sesv2_email_identity.main
terraform output certificate_validation_records
terraform output ses_dkim_records
```

Add these records at Namecheap (see [DNS records](#dns-records-at-namecheap)).

### 4. Apply

```sh
terraform apply
```

The apply waits until the certificate is issued, which usually takes a few minutes after the validation record propagates. Then add the API record from `terraform output dns_records`.

If `route53_zone_id` is set, Terraform creates every record itself and steps 3 and 4 are a single `terraform apply`.

### 5. Configure GitHub

Create the `production` environment and copy the deploy settings into its variables:

```sh
gh api -X PUT "repos/{owner}/{repo}/environments/production" > /dev/null

terraform output -json github_actions_variables \
  | jq -r 'to_entries[] | [.key, .value] | @tsv' \
  | while IFS=$'\t' read -r name value; do gh variable set "$name" --env production --body "$value"; done

gh variable set DEPLOY_TARGET --body ecs
```

`DEPLOY_TARGET` is a repository variable that picks which deploy workflow runs, so only one stack receives each release.

If the environment restricts which branches and tags can deploy, allow `v*` tags.

### 6. Deploy

Run the **Deploy (ECS)** workflow from the Actions tab, or push a `v*` tag. Until the first deploy, the services have no image to run and their tasks fail to start. This is expected.

### 7. Leave the SES sandbox

New SES accounts can only send to verified addresses. Request production access in the SES console (Account dashboard, "Request production access") once the DKIM records verify.

## DNS records at Namecheap

Run `terraform output dns_records` to list every record. Under **Advanced DNS**, add each one as a CNAME record, using `host` for the Host field and `value` for the Value field:

| Purpose | Type | Host | Value |
|---|---|---|---|
| API endpoint | CNAME | `api` | load balancer DNS name |
| ACM certificate validation | CNAME | `_<token>.api` | `_<token>.acm-validations.aws` |
| SES DKIM (three records) | CNAME | `<token>._domainkey` | `<token>.dkim.amazonses.com` |

Keep the validation record after the certificate is issued, because ACM needs it to renew the certificate. Don't change the apex, `www` and `app` records that point at Vercel.

A DMARC policy is recommended for deliverability. Add a TXT record with host `_dmarc` and value `v=DMARC1; p=none; rua=mailto:dmarc@callsign.im`, and tighten `p` once reports look clean.

## Deploys

`.github/workflows/deploy-ecs.yml` runs on `v*` tags and on manual dispatch. It assumes the deploy role through OIDC, then:

1. Builds the image and pushes it to ECR, tagged with the commit SHA. If the image already exists, it skips the build.
2. Registers new revisions of the `api`, `worker` and `migrate` task definitions. Each one copies the latest revision and swaps in the new image.
3. Runs the migration task (`node src/migrate.ts`), waits for it to exit, and prints its logs. A non-zero exit stops the deploy before any traffic moves.
4. Updates the API and worker services and waits until they are stable. A deployment circuit breaker rolls back failed deployments, and the workflow fails if a rollback happened.
5. Moves the `latest` tag to the deployed image.

Terraform ignores the services' task definition and the API's task count, so deploys and autoscaling don't drift from state. When Terraform changes a task definition, for example to add an environment variable, it registers a new revision. That revision goes live on the next deploy.

To roll back, run the workflow on an earlier tag. The image already exists, so only the task definitions and services change. Migrations run on every deploy, so keep them backward compatible.

To run migrations by hand:

```sh
eval "$(terraform output -raw migrate_command)"
```

## Operations

- **Logs**: `aws logs tail /ecs/callsign-production/api --follow` (also `worker`, `migrate`).
- **Shell access**: set `enable_execute_command = true`, apply, deploy, then use `aws ecs execute-command --cluster callsign-production --task <id> --container api --interactive --command sh`. A shell runs with the task role, which can decrypt stored data, so leave it disabled when you don't need it.
- **Database password rotation**: RDS rotates the master password on the schedule in `db_password_rotation_days` (default 30 days). ECS resolves `PGPASSWORD` when a task starts, so after a rotation the tasks must be replaced: either the process exits when Postgres rejects its credentials, or you force a new deployment with `aws ecs update-service --force-new-deployment`.
- **Teardown**: set `deletion_protection = false` and apply before you run `terraform destroy`. RDS takes a final snapshot. The KMS key is deleted 30 days later, and encrypted content in the snapshot can't be read after that, so cancel the deletion if you plan to restore it.

## Cost

Approximate us-east-1 on-demand prices with the default variables:

| Resource | Monthly |
|---|---|
| NAT gateway (one, `single_nat_gateway = true`) | ~$33 + $0.045/GB processed |
| Fargate: 2 API + 1 worker task at 0.25 vCPU / 0.5 GB | ~$27 |
| Application Load Balancer | ~$16 + usage (LCUs) |
| RDS `db.t4g.micro`, 20 GB gp3 | ~$14 |
| Public IPv4 addresses (load balancer, NAT) | ~$11 |
| ElastiCache Valkey `cache.t4g.micro` | ~$9 |
| CloudWatch Logs and Container Insights, Secrets Manager, ECR storage | a few dollars, depending on volume |
| SES | $0.10 per 1,000 emails |

The baseline is roughly $110-120 per month before traffic. The settings that cost the most are `single_nat_gateway = false` (one NAT gateway per zone, about +$33), `db_multi_az = true` (doubles the database cost), `cache_num_nodes`, and the API task count and size.

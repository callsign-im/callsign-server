locals {
  ses_dkim_records = var.enable_ses ? [
    for token in aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens : {
      purpose = "SES DKIM"
      name    = "${token}._domainkey.${var.domain_name}"
      type    = "CNAME"
      value   = "${token}.dkim.amazonses.com"
    }
  ] : []

  dns_records = concat(
    [
      {
        purpose = "API endpoint"
        name    = local.api_domain_name
        type    = "A"
        value   = aws_eip.host.public_ip
      },
    ],
    local.ses_dkim_records,
    [
      {
        purpose = "DMARC policy (recommended)"
        name    = "_dmarc.${var.domain_name}"
        type    = "TXT"
        value   = "v=DMARC1; p=none"
      },
    ],
  )
}

output "api_url" {
  description = "Public URL of the API."
  value       = local.api_url
}

output "public_ip" {
  description = "Elastic IP of the host. The API record points here."
  value       = aws_eip.host.public_ip
}

output "instance_id" {
  description = "ID of the host instance."
  value       = aws_instance.host.id
}

output "availability_zone" {
  description = "Zone of the host and its data volume. Pin it with the availability_zone variable."
  value       = local.availability_zone
}

output "dns_records" {
  description = "Every DNS record the deployment needs. `host` is relative to domain_name, as Namecheap's Host field expects."
  value = [
    for record in local.dns_records : merge(record, {
      host = trimsuffix(record.name, ".${var.domain_name}")
    })
  ]
}

output "shell_command" {
  description = "Opens a root shell on the host through SSM Session Manager."
  value       = "aws ssm start-session --region ${var.aws_region} --target ${aws_instance.host.id}"
}

output "kms_key_arn" {
  description = "ARN of the KMS key that wraps the application's data keys."
  value       = aws_kms_key.data.arn
}

output "backup_bucket" {
  description = "S3 bucket with the hourly database dumps."
  value       = aws_s3_bucket.backups.bucket
}

output "ecr_repository_url" {
  description = "URL of the ECR repository."
  value       = aws_ecr_repository.server.repository_url
}

output "github_deploy_role_arn" {
  description = "IAM role assumed by the deploy workflow."
  value       = aws_iam_role.github_deploy.arn
}

output "github_actions_variables" {
  description = "Variables the deploy workflow reads. Set them on the GitHub environment."
  value = {
    AWS_REGION          = var.aws_region
    AWS_DEPLOY_ROLE_ARN = aws_iam_role.github_deploy.arn
    ECR_REPOSITORY      = aws_ecr_repository.server.name
    EC2_INSTANCE_ID     = aws_instance.host.id
    RELEASES_BUCKET     = aws_s3_bucket.releases.bucket
    API_URL             = local.api_url
  }
}

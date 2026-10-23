output "api_url" {
  description = "Public URL of the API."
  value       = local.api_url
}

output "alb_dns_name" {
  description = "DNS name of the load balancer."
  value       = aws_lb.main.dns_name
}

output "dns_records" {
  description = "Every DNS record the deployment needs. `host` is relative to domain_name, as Namecheap's Host field expects. Created automatically when route53_zone_id is set."
  value = [
    for record in local.dns_records : merge(record, {
      host = trimsuffix(record.name, ".${var.domain_name}")
    })
  ]
}

output "certificate_validation_records" {
  description = "CNAME records ACM needs to issue the API certificate. Available after a targeted apply of aws_acm_certificate.api."
  value = [
    merge(local.certificate_validation_record, {
      host = trimsuffix(local.certificate_validation_record.name, ".${var.domain_name}")
    }),
  ]
}

output "ses_dkim_records" {
  description = "Easy DKIM CNAME records that verify domain_name with SES."
  value = [
    for record in local.ses_dkim_records : merge(record, {
      host = trimsuffix(record.name, ".${var.domain_name}")
    })
  ]
}

output "kms_key_arn" {
  description = "ARN of the KMS key that wraps the application's data keys."
  value       = aws_kms_key.data.arn
}

output "ecr_repository_url" {
  description = "URL of the ECR repository."
  value       = aws_ecr_repository.server.repository_url
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster."
  value       = aws_ecs_cluster.main.name
}

output "ecs_api_service_name" {
  description = "Name of the API service."
  value       = aws_ecs_service.api.name
}

output "ecs_worker_service_name" {
  description = "Name of the worker service."
  value       = aws_ecs_service.worker.name
}

output "migrate_task_definition_family" {
  description = "Task definition family of the migration task."
  value       = aws_ecs_task_definition.app["migrate"].family
}

output "migrate_network_configuration" {
  description = "Value for --network-configuration when running the migration task."
  value       = local.migrate_network_configuration
}

output "migrate_command" {
  description = "Runs database migrations with the latest revision of the migration task definition."
  value = join(" ", [
    "aws ecs run-task",
    "--region ${var.aws_region}",
    "--cluster ${aws_ecs_cluster.main.name}",
    "--launch-type FARGATE",
    "--task-definition ${aws_ecs_task_definition.app["migrate"].family}",
    "--network-configuration '${local.migrate_network_configuration}'",
    "--started-by manual",
  ])
}

output "log_groups" {
  description = "CloudWatch log groups per component."
  value       = { for component, group in aws_cloudwatch_log_group.app : component => group.name }
}

output "database_endpoint" {
  description = "PostgreSQL endpoint (host:port)."
  value       = aws_db_instance.main.endpoint
}

output "database_master_secret_arn" {
  description = "Secrets Manager secret holding the RDS-managed master credentials."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "cache_endpoint" {
  description = "Primary endpoint of the Valkey replication group."
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "github_deploy_role_arn" {
  description = "IAM role assumed by the deploy workflow."
  value       = aws_iam_role.github_deploy.arn
}

output "github_actions_variables" {
  description = "Variables the deploy workflow reads. Set them on the GitHub environment."
  value = {
    AWS_REGION                        = var.aws_region
    AWS_DEPLOY_ROLE_ARN               = aws_iam_role.github_deploy.arn
    ECR_REPOSITORY                    = aws_ecr_repository.server.name
    ECS_CLUSTER                       = aws_ecs_cluster.main.name
    ECS_API_SERVICE                   = aws_ecs_service.api.name
    ECS_WORKER_SERVICE                = aws_ecs_service.worker.name
    ECS_API_TASK_FAMILY               = aws_ecs_task_definition.app["api"].family
    ECS_WORKER_TASK_FAMILY            = aws_ecs_task_definition.app["worker"].family
    ECS_MIGRATE_TASK_FAMILY           = aws_ecs_task_definition.app["migrate"].family
    ECS_MIGRATE_NETWORK_CONFIGURATION = local.migrate_network_configuration
  }
}

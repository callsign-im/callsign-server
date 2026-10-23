resource "random_password" "database" {
  length  = 40
  special = false
}

locals {
  app_environment = {
    NODE_ENV       = "production"
    LOG_LEVEL      = var.log_level
    AWS_REGION     = var.aws_region
    PGHOST         = "postgres"
    PGPORT         = "5432"
    PGDATABASE     = "callsign"
    PGUSER         = "callsign"
    PGPASSWORD     = random_password.database.result
    PGSSLMODE      = "disable"
    REDIS_URL      = "redis://valkey:6379"
    PUBLIC_API_URL = local.api_url
    APP_URL        = local.app_url
    SITE_URL       = local.site_url
    MAIL_FROM      = local.mail_from
    SMTP_URL       = local.smtp_url
    KMS_KEY_ID     = aws_kms_key.data.arn
    API_DOMAIN     = local.api_domain_name
  }
}

# Every deploy writes this to /opt/callsign/.env. Single quotes keep Docker Compose from interpolating values.
resource "aws_ssm_parameter" "environment" {
  name        = "/${local.name_prefix}/environment"
  description = "Environment file for the Callsign containers"
  type        = "SecureString"
  value       = join("", [for name, value in local.app_environment : "${name}='${value}'\n"])
}

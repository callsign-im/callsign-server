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
    ADMIN_EMAILS   = join(",", var.admin_emails)
    # Passkeys are bound to the root domain, so they keep working wherever the dashboard lives.
    WEBAUTHN_RP_ID = var.domain_name
    # Empty values turn Telegram and the email bridge off.
    TELEGRAM_BOT_TOKEN    = var.telegram_bot_token == null ? "" : var.telegram_bot_token
    EMAIL_BRIDGE_DOMAIN   = var.email_bridge_domain == null ? "" : var.email_bridge_domain
    RESEND_API_KEY        = var.resend_api_key == null ? "" : var.resend_api_key
    RESEND_WEBHOOK_SECRET = var.resend_webhook_secret == null ? "" : var.resend_webhook_secret
  }
}

# Every deploy writes this to /opt/callsign/.env. Single quotes keep Docker Compose from interpolating values.
resource "aws_ssm_parameter" "environment" {
  name        = "/${local.name_prefix}/environment"
  description = "Environment file for the Callsign containers"
  type        = "SecureString"
  value       = join("", [for name, value in local.app_environment : "${name}='${value}'\n"])
}

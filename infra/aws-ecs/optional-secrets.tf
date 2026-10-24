# Secrets for optional features: each one is created only when its variable is set.
locals {
  optional_secret_values = {
    TELEGRAM_BOT_TOKEN    = var.telegram_bot_token
    RESEND_API_KEY        = var.resend_api_key
    RESEND_WEBHOOK_SECRET = var.resend_webhook_secret
  }
  optional_secrets = toset([
    for name, value in local.optional_secret_values : name if nonsensitive(value != null)
  ])
}

resource "aws_secretsmanager_secret" "optional" {
  for_each                = local.optional_secrets
  name                    = "${local.name_prefix}/${lower(replace(each.key, "_", "-"))}"
  description             = "${each.key} for the Callsign API and worker"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "optional" {
  for_each      = local.optional_secrets
  secret_id     = aws_secretsmanager_secret.optional[each.key].id
  secret_string = local.optional_secret_values[each.key]
}

moved {
  from = aws_secretsmanager_secret.telegram_bot_token[0]
  to   = aws_secretsmanager_secret.optional["TELEGRAM_BOT_TOKEN"]
}

moved {
  from = aws_secretsmanager_secret_version.telegram_bot_token[0]
  to   = aws_secretsmanager_secret_version.optional["TELEGRAM_BOT_TOKEN"]
}

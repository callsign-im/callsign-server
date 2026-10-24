locals {
  telegram_enabled = nonsensitive(var.telegram_bot_token != null)
}

resource "aws_secretsmanager_secret" "telegram_bot_token" {
  count                   = local.telegram_enabled ? 1 : 0
  name                    = "${local.name_prefix}/telegram-bot-token"
  description             = "Telegram bot token used by the Callsign API and worker"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "telegram_bot_token" {
  count         = local.telegram_enabled ? 1 : 0
  secret_id     = aws_secretsmanager_secret.telegram_bot_token[0].id
  secret_string = var.telegram_bot_token
}

resource "aws_sesv2_email_identity" "main" {
  count = var.enable_ses ? 1 : 0

  email_identity = var.domain_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_iam_user" "smtp" {
  count = var.enable_ses ? 1 : 0

  name = "${local.name_prefix}-ses-smtp"
}

data "aws_iam_policy_document" "smtp" {
  count = var.enable_ses ? 1 : 0

  statement {
    sid       = "SendFromDomain"
    actions   = ["ses:SendRawEmail"]
    resources = ["arn:${local.partition}:ses:${var.aws_region}:${local.account_id}:identity/*"]

    condition {
      test     = "StringLike"
      variable = "ses:FromAddress"
      values   = ["*@${var.domain_name}"]
    }
  }
}

resource "aws_iam_user_policy" "smtp" {
  count = var.enable_ses ? 1 : 0

  name   = "ses-send"
  user   = aws_iam_user.smtp[0].name
  policy = data.aws_iam_policy_document.smtp[0].json
}

resource "aws_iam_access_key" "smtp" {
  count = var.enable_ses ? 1 : 0

  user = aws_iam_user.smtp[0].name
}

locals {
  smtp_url = var.enable_ses ? format(
    "smtps://%s:%s@email-smtp.%s.amazonaws.com:465",
    urlencode(aws_iam_access_key.smtp[0].id),
    urlencode(aws_iam_access_key.smtp[0].ses_smtp_password_v4),
    var.aws_region,
  ) : var.smtp_url
}

resource "aws_secretsmanager_secret" "smtp_url" {
  name                    = "${local.name_prefix}/smtp-url"
  description             = "SMTP connection URL used by the Callsign API and worker"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "smtp_url" {
  secret_id     = aws_secretsmanager_secret.smtp_url.id
  secret_string = local.smtp_url
}

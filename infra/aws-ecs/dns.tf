resource "aws_acm_certificate" "api" {
  domain_name       = local.api_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  # The certificate covers a single hostname, so ACM asks for exactly one validation record.
  certificate_validation_record = one([
    for option in aws_acm_certificate.api.domain_validation_options : {
      name  = trimsuffix(option.resource_record_name, ".")
      type  = option.resource_record_type
      value = trimsuffix(option.resource_record_value, ".")
    }
  ])

  ses_dkim_records = var.enable_ses ? [
    for token in aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens : {
      name  = "${token}._domainkey.${var.domain_name}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }
  ] : []

  dns_records = concat(
    [
      {
        purpose = "API endpoint"
        name    = local.api_domain_name
        type    = "CNAME"
        value   = aws_lb.main.dns_name
      },
    ],
    [merge(local.certificate_validation_record, { purpose = "ACM certificate validation" })],
    [for record in local.ses_dkim_records : merge(record, { purpose = "SES DKIM" })],
  )
}

# Without a Route 53 zone this waits until the validation CNAME exists at the external DNS provider.
resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = local.manage_dns ? aws_route53_record.certificate_validation[*].fqdn : null
}

resource "aws_route53_record" "certificate_validation" {
  count = local.manage_dns ? 1 : 0

  zone_id         = var.route53_zone_id
  name            = local.certificate_validation_record.name
  type            = local.certificate_validation_record.type
  ttl             = 300
  records         = [local.certificate_validation_record.value]
  allow_overwrite = true
}

resource "aws_route53_record" "api" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = local.api_domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "ses_dkim" {
  count = local.manage_dns && var.enable_ses ? 3 : 0

  zone_id = var.route53_zone_id
  name    = "${aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

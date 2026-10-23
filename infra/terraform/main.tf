data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  project     = "callsign"
  name_prefix = "${local.project}-${var.environment}"

  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  azs        = slice(data.aws_availability_zones.available.names, 0, 2)

  api_domain_name = "${var.api_subdomain}.${var.domain_name}"
  api_url         = "https://${local.api_domain_name}"
  app_url         = coalesce(var.app_url, "https://app.${var.domain_name}")
  site_url        = coalesce(var.site_url, "https://${var.domain_name}")
  mail_from       = coalesce(var.mail_from, "Callsign <no-reply@${var.domain_name}>")

  manage_dns = var.route53_zone_id != null
}

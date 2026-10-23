data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_ec2_instance_type_offerings" "host" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

locals {
  project     = "callsign"
  name_prefix = "${local.project}-${var.environment}"

  account_id        = data.aws_caller_identity.current.account_id
  partition         = data.aws_partition.current.partition
  availability_zone = coalesce(var.availability_zone, sort(data.aws_ec2_instance_type_offerings.host.locations)[0])

  api_domain_name = "${var.api_subdomain}.${var.domain_name}"
  api_url         = "https://${local.api_domain_name}"
  app_url         = coalesce(var.app_url, "https://app.${var.domain_name}")
  site_url        = coalesce(var.site_url, "https://${var.domain_name}")
  mail_from       = coalesce(var.mail_from, "Callsign <no-reply@${var.domain_name}>")
}

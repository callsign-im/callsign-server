module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.7"

  name = local.name_prefix
  cidr = var.vpc_cidr
  azs  = local.azs

  public_subnets  = [for i in range(length(local.azs)) : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets = [for i in range(length(local.azs)) : cidrsubnet(var.vpc_cidr, 8, i + 10)]

  enable_nat_gateway     = true
  single_nat_gateway     = var.single_nat_gateway
  one_nat_gateway_per_az = !var.single_nat_gateway

  enable_dns_hostnames = true
  enable_dns_support   = true
}

# ECR serves image layers from S3; the gateway endpoint keeps image pulls off the NAT gateway.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.vpc.private_route_table_ids

  tags = {
    Name = "${local.name_prefix}-s3"
  }
}

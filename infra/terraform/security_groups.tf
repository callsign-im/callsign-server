locals {
  app_components   = toset(["api", "worker", "migrate"])
  postgres_clients = toset(["api", "worker", "migrate"])
  redis_clients    = toset(["api", "worker"])

  smtp_egress = {
    for pair in setproduct(["api", "worker"], [465, 587]) : "${pair[0]}-${pair[1]}" => {
      component = pair[0]
      port      = pair[1]
    }
  }
}

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Public load balancer for the Callsign API"
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name = "${local.name_prefix}-alb"
  }
}

resource "aws_security_group" "app" {
  for_each = local.app_components

  name        = "${local.name_prefix}-${each.key}"
  description = "Callsign ${each.key} tasks"
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name = "${local.name_prefix}-${each.key}"
  }
}

resource "aws_security_group" "database" {
  name        = "${local.name_prefix}-database"
  description = "Callsign PostgreSQL"
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name = "${local.name_prefix}-database"
  }
}

resource "aws_security_group" "cache" {
  name        = "${local.name_prefix}-cache"
  description = "Callsign Valkey"
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name = "${local.name_prefix}-cache"
  }
}

# Load balancer

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from the internet (redirected to HTTPS)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Traffic and health checks to API tasks"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.app["api"].id
}

# Application tasks

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.app["api"].id
  description                  = "HTTP from the load balancer"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "app_https" {
  for_each = aws_security_group.app

  security_group_id = each.value.id
  description       = "HTTPS to AWS APIs and the internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "app_smtp" {
  for_each = local.smtp_egress

  security_group_id = aws_security_group.app[each.value.component].id
  description       = "SMTP submission on port ${each.value.port}"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "app_postgres" {
  for_each = local.postgres_clients

  security_group_id            = aws_security_group.app[each.key].id
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.database.id
}

resource "aws_vpc_security_group_egress_rule" "app_redis" {
  for_each = local.redis_clients

  security_group_id            = aws_security_group.app[each.key].id
  description                  = "Valkey"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.cache.id
}

# Data stores

resource "aws_vpc_security_group_ingress_rule" "database" {
  for_each = local.postgres_clients

  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from ${each.key} tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.app[each.key].id
}

resource "aws_vpc_security_group_ingress_rule" "cache" {
  for_each = local.redis_clients

  security_group_id            = aws_security_group.cache.id
  description                  = "Valkey from ${each.key} tasks"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.app[each.key].id
}

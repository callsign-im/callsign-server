locals {
  cache_engine_major = split(".", var.cache_engine_version)[0]
}

resource "aws_elasticache_subnet_group" "main" {
  name       = local.name_prefix
  subnet_ids = module.vpc.private_subnets
}

resource "aws_elasticache_parameter_group" "main" {
  name   = "${local.name_prefix}-valkey${local.cache_engine_major}"
  family = "valkey${local.cache_engine_major}"

  parameter {
    name  = "maxmemory-policy"
    value = var.cache_maxmemory_policy
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = local.name_prefix
  description          = "Callsign ${var.environment} cache"

  engine               = "valkey"
  engine_version       = var.cache_engine_version
  node_type            = var.cache_node_type
  num_cache_clusters   = var.cache_num_nodes
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.main.name

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.cache.id]

  automatic_failover_enabled = var.cache_num_nodes > 1
  multi_az_enabled           = var.cache_num_nodes > 1

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  snapshot_retention_limit   = var.cache_snapshot_retention_days
  snapshot_window            = "02:00-03:00"
  maintenance_window         = "sun:05:30-sun:06:30"
  auto_minor_version_upgrade = true
}

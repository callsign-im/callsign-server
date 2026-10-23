resource "aws_db_subnet_group" "main" {
  name       = local.name_prefix
  subnet_ids = module.vpc.private_subnets
}

resource "aws_db_instance" "main" {
  identifier     = local.name_prefix
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  # Upgrade at end of standard support instead of silently enrolling in paid RDS Extended Support.
  engine_lifecycle_support = "open-source-rds-extended-support-disabled"

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name                     = var.db_name
  username                    = var.db_username
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period    = var.db_backup_retention_days
  backup_window              = "03:00-04:00"
  maintenance_window         = "sun:04:30-sun:05:30"
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true

  performance_insights_enabled          = var.db_performance_insights_enabled
  performance_insights_retention_period = var.db_performance_insights_enabled ? 7 : null

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name_prefix}-final"
}

# Overrides the 7-day default schedule of the RDS-managed master secret. ECS injects
# PGPASSWORD when a task starts, so each rotation needs running tasks to be replaced.
resource "aws_secretsmanager_secret_rotation" "database" {
  count = var.db_password_rotation_days == null ? 0 : 1

  secret_id          = aws_db_instance.main.master_user_secret[0].secret_arn
  rotate_immediately = false

  rotation_rules {
    automatically_after_days = var.db_password_rotation_days
  }
}

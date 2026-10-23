locals {
  image = "${aws_ecr_repository.server.repository_url}:${var.image_tag}"

  database_environment = {
    NODE_ENV   = "production"
    LOG_LEVEL  = var.log_level
    PGHOST     = aws_db_instance.main.address
    PGPORT     = tostring(aws_db_instance.main.port)
    PGDATABASE = aws_db_instance.main.db_name
    PGUSER     = aws_db_instance.main.username
    PGSSLMODE  = "require"
  }

  app_environment = merge(local.database_environment, {
    REDIS_URL      = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
    PUBLIC_API_URL = local.api_url
    WEB_URL        = local.web_url
    MAIL_FROM      = local.mail_from
    KMS_KEY_ID     = aws_kms_key.data.arn
  })

  database_secrets = {
    PGPASSWORD = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::"
  }

  app_secrets = merge(local.database_secrets, {
    SMTP_URL = aws_secretsmanager_secret.smtp_url.arn
  })

  containers = {
    api = {
      command     = ["node", "src/server.ts"]
      cpu         = var.api_cpu
      memory      = var.api_memory
      port        = 8080
      environment = merge(local.app_environment, { PORT = "8080" })
      secrets     = local.app_secrets
    }
    worker = {
      command     = ["node", "src/worker.ts"]
      cpu         = var.worker_cpu
      memory      = var.worker_memory
      port        = null
      environment = local.app_environment
      secrets     = local.app_secrets
    }
    migrate = {
      command     = ["node", "src/migrate.ts"]
      cpu         = var.migrate_cpu
      memory      = var.migrate_memory
      port        = null
      environment = local.database_environment
      secrets     = local.database_secrets
    }
  }

  migrate_network_configuration = format(
    "awsvpcConfiguration={subnets=[%s],securityGroups=[%s],assignPublicIp=DISABLED}",
    join(",", module.vpc.private_subnets),
    aws_security_group.app["migrate"].id,
  )
}

resource "aws_ecs_cluster" "main" {
  name = local.name_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  for_each = local.app_components

  name              = "/ecs/${local.name_prefix}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "app" {
  for_each = local.containers

  family                   = "${local.name_prefix}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = local.image
      essential = true
      command   = each.value.command

      portMappings = each.value.port == null ? [] : [
        {
          containerPort = each.value.port
          hostPort      = each.value.port
          protocol      = "tcp"
        },
      ]

      environment = [for name, value in each.value.environment : { name = name, value = value }]
      secrets     = [for name, value_from in each.value.secrets : { name = name, valueFrom = value_from }]

      linuxParameters = {
        initProcessEnabled = true
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.app[each.key].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    },
  ])
}

resource "aws_ecs_service" "api" {
  name                   = "${local.name_prefix}-api"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.app["api"].arn
  desired_count          = var.api_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = var.enable_execute_command
  propagate_tags         = "SERVICE"

  health_check_grace_period_seconds  = 30
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.app["api"].id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 8080
  }

  # The deploy workflow registers new task definition revisions, and autoscaling owns the task count.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  name                   = "${local.name_prefix}-worker"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.app["worker"].arn
  desired_count          = var.worker_desired_count
  launch_type            = "FARGATE"
  enable_execute_command = var.enable_execute_command
  propagate_tags         = "SERVICE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.app["worker"].id]
    assign_public_ip = false
  }

  lifecycle {
    ignore_changes = [task_definition]
  }
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_min_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name_prefix}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.api_cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

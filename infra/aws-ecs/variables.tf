# General

variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name. Resources are named callsign-<environment>-<thing>."
  type        = string
  default     = "production"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,14}$", var.environment))
    error_message = "environment must be 1-15 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "tags" {
  description = "Additional tags applied to every resource."
  type        = map(string)
  default     = {}
}

# Domains

variable "domain_name" {
  description = "Root domain. SES sends mail for it and the API is served from <api_subdomain>.<domain_name>."
  type        = string
  default     = "callsign.im"
}

variable "api_subdomain" {
  description = "Subdomain of domain_name that serves the API."
  type        = string
  default     = "api"
}

variable "app_url" {
  description = "URL of the dashboard, exposed to the app as APP_URL. Defaults to https://app.<domain_name>."
  type        = string
  default     = null
}

variable "site_url" {
  description = "URL of the website, exposed to the app as SITE_URL. Defaults to https://<domain_name>."
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for domain_name. When set, DNS records are created automatically; when null, they are only listed in the outputs for manual entry."
  type        = string
  default     = null
}

# Network

variable "vpc_cidr" {
  description = "CIDR block of the VPC."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block."
  }
}

variable "single_nat_gateway" {
  description = "Share one NAT gateway across both availability zones. Cheaper, but private subnets lose outbound access if that zone fails."
  type        = bool
  default     = true
}

# Database

variable "db_engine_version" {
  description = "PostgreSQL engine version. A major version (e.g. 17) lets RDS pick and auto-upgrade the minor version."
  type        = string
  default     = "17"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Initial storage in GiB."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Upper limit in GiB for storage autoscaling. Set to 0 to disable autoscaling."
  type        = number
  default     = 100
}

variable "db_name" {
  description = "Name of the application database."
  type        = string
  default     = "callsign"
}

variable "db_username" {
  description = "Master username. RDS generates the password and stores it in Secrets Manager."
  type        = string
  default     = "callsign"
}

variable "db_multi_az" {
  description = "Run a synchronous standby in a second availability zone. Roughly doubles the database cost."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Days to keep automated backups."
  type        = number
  default     = 7

  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be between 1 and 35."
  }
}

variable "db_performance_insights_enabled" {
  description = "Enable Performance Insights with the free 7-day retention."
  type        = bool
  default     = false
}

variable "db_password_rotation_days" {
  description = "Rotation interval for the RDS-managed master password. Null keeps the RDS default of 7 days."
  type        = number
  default     = 30
  nullable    = true

  validation {
    condition     = var.db_password_rotation_days == null || try(var.db_password_rotation_days >= 1 && var.db_password_rotation_days <= 365, false)
    error_message = "db_password_rotation_days must be null or between 1 and 365."
  }
}

variable "deletion_protection" {
  description = "Protect the database and load balancer from deletion. Disable before running terraform destroy."
  type        = bool
  default     = true
}

# Cache

variable "cache_engine_version" {
  description = "Valkey engine version (major.minor)."
  type        = string
  default     = "8.2"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+$", var.cache_engine_version))
    error_message = "cache_engine_version must look like 8.2."
  }
}

variable "cache_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.micro"
}

variable "cache_num_nodes" {
  description = "Number of Valkey nodes (primary plus replicas). Two or more enables automatic failover and Multi-AZ."
  type        = number
  default     = 1

  validation {
    condition     = var.cache_num_nodes >= 1 && var.cache_num_nodes <= 6
    error_message = "cache_num_nodes must be between 1 and 6."
  }
}

variable "cache_snapshot_retention_days" {
  description = "Days to keep daily Valkey snapshots. 0 disables snapshots."
  type        = number
  default     = 1
}

variable "cache_maxmemory_policy" {
  description = "Valkey eviction policy. noeviction rejects writes when memory is full instead of silently dropping queued jobs."
  type        = string
  default     = "noeviction"
}

# Container image

variable "ecr_repository_name" {
  description = "Name of the ECR repository for the server image."
  type        = string
  default     = "callsign-server"
}

variable "ecr_image_retention_count" {
  description = "Number of images to keep in ECR."
  type        = number
  default     = 30
}

variable "image_tag" {
  description = "Image tag used by task definition revisions that Terraform registers. Deploys register their own revisions pinned to the git SHA."
  type        = string
  default     = "latest"
}

# Services

variable "log_level" {
  description = "Application log level (LOG_LEVEL)."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["fatal", "error", "warn", "info", "debug", "trace", "silent"], var.log_level)
    error_message = "log_level must be one of fatal, error, warn, info, debug, trace or silent."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for task logs."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a retention period supported by CloudWatch Logs."
  }
}

variable "api_cpu" {
  description = "CPU units for an API task (1024 = 1 vCPU)."
  type        = number
  default     = 256
}

variable "api_memory" {
  description = "Memory in MiB for an API task."
  type        = number
  default     = 512
}

variable "api_desired_count" {
  description = "Initial number of API tasks. Autoscaling manages the count afterwards."
  type        = number
  default     = 2

  validation {
    condition     = var.api_desired_count >= var.api_min_count && var.api_desired_count <= var.api_max_count
    error_message = "api_desired_count must be between api_min_count and api_max_count."
  }
}

variable "api_min_count" {
  description = "Minimum number of API tasks."
  type        = number
  default     = 2

  validation {
    condition     = var.api_min_count >= 1
    error_message = "api_min_count must be at least 1."
  }
}

variable "api_max_count" {
  description = "Maximum number of API tasks."
  type        = number
  default     = 6

  validation {
    condition     = var.api_max_count >= var.api_min_count
    error_message = "api_max_count must be greater than or equal to api_min_count."
  }
}

variable "api_cpu_target" {
  description = "Average CPU utilization (percent) that API autoscaling aims for."
  type        = number
  default     = 60
}

variable "worker_cpu" {
  description = "CPU units for a worker task (1024 = 1 vCPU)."
  type        = number
  default     = 256
}

variable "worker_memory" {
  description = "Memory in MiB for a worker task."
  type        = number
  default     = 512
}

variable "worker_desired_count" {
  description = "Number of worker tasks."
  type        = number
  default     = 1
}

variable "migrate_cpu" {
  description = "CPU units for the migration task (1024 = 1 vCPU)."
  type        = number
  default     = 256
}

variable "migrate_memory" {
  description = "Memory in MiB for the migration task."
  type        = number
  default     = 512
}

variable "enable_execute_command" {
  description = "Allow shell access to running tasks with ECS Exec (aws ecs execute-command)."
  type        = bool
  default     = false
}

# Load balancer

variable "alb_idle_timeout" {
  description = "Seconds an idle connection stays open. Must exceed the interval between SSE keep-alives."
  type        = number
  default     = 120

  validation {
    condition     = var.alb_idle_timeout >= 1 && var.alb_idle_timeout <= 4000
    error_message = "alb_idle_timeout must be between 1 and 4000 seconds."
  }
}

variable "alb_ssl_policy" {
  description = "TLS security policy of the HTTPS listener."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09"
}

# Email

variable "enable_ses" {
  description = "Verify domain_name with Amazon SES (Easy DKIM) and create SMTP credentials for it. When false, smtp_url is required."
  type        = bool
  default     = true
}

variable "email_bridge_domain" {
  description = "Subdomain whose mail Resend receives for the email bridge, e.g. agents.callsign.im (EMAIL_BRIDGE_DOMAIN). Agents get <handle>@ this domain. Leave unset to turn the bridge off."
  type        = string
  default     = null
}

variable "resend_api_key" {
  description = "Resend API key with full access, used to read received emails (RESEND_API_KEY)."
  type        = string
  default     = null
  sensitive   = true
}

variable "resend_webhook_secret" {
  description = "Signing secret (whsec_...) of the Resend webhook that posts email.received to /v1/email/inbound (RESEND_WEBHOOK_SECRET)."
  type        = string
  default     = null
  sensitive   = true
}

variable "telegram_bot_token" {
  description = "Token from @BotFather for the bot that brings agents' questions to their owners on Telegram (TELEGRAM_BOT_TOKEN). Leave unset to turn Telegram off."
  type        = string
  default     = null
  sensitive   = true
}

variable "admin_emails" {
  description = "Owner emails that can review abuse reports and suspend agents in the dashboard (ADMIN_EMAILS). They also get an email for each new report."
  type        = list(string)
  default     = []
}

variable "mail_from" {
  description = "Sender for outgoing email (MAIL_FROM). Defaults to \"Callsign <no-reply@<domain_name>>\"."
  type        = string
  default     = null
}

variable "smtp_url" {
  description = "SMTP connection URL with credentials, e.g. smtps://user:pass@smtp.example.com:465. When set, it is used instead of the SES credentials, for example while SES is still in the sandbox."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = var.enable_ses || var.smtp_url != null
    error_message = "smtp_url is required when enable_ses is false."
  }
}

# GitHub Actions

variable "github_repository" {
  description = "GitHub repository allowed to deploy, as owner/name."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like owner/name."
  }
}

variable "github_subject_prefix" {
  description = "Prefix of the OIDC subject GitHub issues for github_repository. Repositories with immutable subjects use repo:<owner>@<owner id>/<name>@<repository id>; get it with `gh api repos/<owner>/<name>/actions/oidc/customization/sub --jq .sub_claim_prefix`. Defaults to repo:<github_repository>."
  type        = string
  default     = null

  validation {
    condition     = var.github_subject_prefix == null || can(regex("^repo:", var.github_subject_prefix))
    error_message = "github_subject_prefix must start with repo:."
  }
}

variable "github_environment" {
  description = "GitHub environment whose jobs may assume the deploy role. Defaults to the value of environment."
  type        = string
  default     = null
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub Actions OIDC provider. Set to false if the account already has one."
  type        = bool
  default     = true
}

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

# Host

variable "instance_type" {
  description = "EC2 instance type. Must be a Graviton (arm64) type, because the deploy workflow builds arm64 images."
  type        = string
  default     = "t4g.small"

  validation {
    condition     = can(regex("^[a-z]+[0-9]+g[a-z]*\\.", var.instance_type))
    error_message = "instance_type must be a Graviton (arm64) type, e.g. t4g.small or m7g.medium."
  }
}

variable "availability_zone" {
  description = "Availability zone of the host and its data volume. Defaults to the first zone that offers instance_type. Pin it after the first apply: changing it replaces the data volume."
  type        = string
  default     = null
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block."
  }
}

variable "root_volume_size" {
  description = "Size in GiB of the root volume (operating system, Docker images and logs)."
  type        = number
  default     = 20
}

variable "data_volume_size" {
  description = "Size in GiB of the data volume (PostgreSQL and TLS certificates). It survives host replacement."
  type        = number
  default     = 20
}

variable "deletion_protection" {
  description = "Protect the host from termination. Disable before running terraform destroy."
  type        = bool
  default     = true
}

variable "log_level" {
  description = "Application log level (LOG_LEVEL)."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["fatal", "error", "warn", "info", "debug", "trace", "silent"], var.log_level)
    error_message = "log_level must be one of fatal, error, warn, info, debug, trace or silent."
  }
}

# Backups

variable "backup_retention_days" {
  description = "Days to keep the hourly database dumps in S3."
  type        = number
  default     = 30
}

variable "snapshot_retention_count" {
  description = "Number of daily snapshots of the data volume to keep."
  type        = number
  default     = 7

  validation {
    condition     = var.snapshot_retention_count >= 1 && var.snapshot_retention_count <= 1000
    error_message = "snapshot_retention_count must be between 1 and 1000."
  }
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

# Email

variable "enable_ses" {
  description = "Verify domain_name with Amazon SES (Easy DKIM) and create SMTP credentials for it. When false, smtp_url is required."
  type        = bool
  default     = true
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

# Cost alerts

variable "monthly_budget" {
  description = "Monthly spend in USD, before credits, that triggers budget alerts."
  type        = number
  default     = 30
}

variable "budget_alert_emails" {
  description = "Addresses notified at 80% of actual and 100% of forecasted monthly spend. Leave empty to skip the budget."
  type        = list(string)
  default     = []
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

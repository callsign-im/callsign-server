provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(var.tags, {
      Project     = local.project
      Environment = var.environment
      ManagedBy   = "terraform"
    })
  }
}

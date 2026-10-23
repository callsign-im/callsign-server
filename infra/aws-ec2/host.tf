data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

resource "aws_network_interface" "host" {
  subnet_id       = aws_subnet.public.id
  security_groups = [aws_security_group.host.id]

  tags = {
    Name = "${local.name_prefix}-host"
  }
}

# Bound to the network interface before the host boots, so first-boot setup already has internet access
# and the address never changes when the host is replaced.
resource "aws_eip" "host" {
  domain            = "vpc"
  network_interface = aws_network_interface.host.id

  tags = {
    Name = local.name_prefix
  }

  depends_on = [aws_internet_gateway.main]
}

# PostgreSQL and Caddy's certificates live here, apart from the root volume, so the host can be rebuilt.
resource "aws_ebs_volume" "data" {
  availability_zone = local.availability_zone
  type              = "gp3"
  size              = var.data_volume_size
  encrypted         = true
  final_snapshot    = true

  tags = {
    Name      = "${local.name_prefix}-data"
    Snapshots = local.name_prefix
  }
}

resource "aws_instance" "host" {
  ami                     = data.aws_ssm_parameter.ubuntu.insecure_value
  instance_type           = var.instance_type
  iam_instance_profile    = aws_iam_instance_profile.host.name
  disable_api_termination = var.deletion_protection

  user_data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    aws_region        = var.aws_region
    environment_param = aws_ssm_parameter.environment.name
    backup_bucket     = aws_s3_bucket.backups.bucket
    data_volume_id    = aws_ebs_volume.data.id
    bootstrap_script  = base64encode(file("${path.module}/bootstrap.sh"))
  })
  user_data_replace_on_change = true

  primary_network_interface {
    network_interface_id = aws_network_interface.host.id
  }

  metadata_options {
    http_tokens = "required"
    # Containers are one network hop away from the host and read the instance role from IMDS.
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size
    encrypted   = true
  }

  tags = {
    Name = local.name_prefix
  }

  # A newer Ubuntu image should not rebuild the host on its own. Use terraform apply -replace to adopt one.
  lifecycle {
    ignore_changes = [ami]
  }

  depends_on = [aws_eip.host]
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.host.id
  stop_instance_before_detaching = true
}

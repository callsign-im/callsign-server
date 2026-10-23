#!/usr/bin/env bash
# First boot: mounts the data volume, installs the AWS CLI and starts Docker. Releases are installed by deploys.
set -euo pipefail

volume_id="$1"
device="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volume_id//-/}"
data_dir=/var/lib/callsign

# Terraform attaches the data volume only after the instance is running.
for _ in $(seq 120); do
  [ -e "$device" ] && break
  sleep 5
done
if [ ! -e "$device" ]; then
  echo "Data volume ${volume_id} was never attached." >&2
  exit 1
fi

if ! blkid "$device" > /dev/null; then
  mkfs.ext4 -L callsign-data "$device"
fi

uuid=$(blkid -s UUID -o value "$device")
mkdir -p "$data_dir"
grep -q "UUID=${uuid}" /etc/fstab || echo "UUID=${uuid} ${data_dir} ext4 defaults,nofail 0 2" >> /etc/fstab
mountpoint -q "$data_dir" || mount "$data_dir"
mkdir -p "$data_dir/postgres" "$data_dir/caddy"

# Without the volume, PostgreSQL would start an empty database on the root disk.
mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=%s\n' "$data_dir" > /etc/systemd/system/docker.service.d/callsign-data.conf
systemctl daemon-reload

curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
unzip -q -o /tmp/awscliv2.zip -d /tmp
/tmp/aws/install --update
rm -rf /tmp/aws /tmp/awscliv2.zip

systemctl enable --now docker
mkdir -p /opt/callsign/releases

# Wraps the data keys that encrypt messages, ledger entries, contacts and rules at rest.
# Administrators can manage the key, but only the application can use it.
data "aws_iam_policy_document" "data_key" {
  statement {
    sid = "KeyAdministration"

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }

    actions = [
      "kms:CancelKeyDeletion",
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:Describe*",
      "kms:DisableKey",
      "kms:DisableKeyRotation",
      "kms:EnableKey",
      "kms:EnableKeyRotation",
      "kms:Get*",
      "kms:List*",
      "kms:PutKeyPolicy",
      "kms:RevokeGrant",
      "kms:RotateKeyOnDemand",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateAlias",
      "kms:UpdateKeyDescription",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ApplicationUse"

    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.task.arn]
    }

    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "data" {
  description             = "Wraps the data keys that encrypt ${local.name_prefix} application data."
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.data_key.json
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name_prefix}-data"
  target_key_id = aws_kms_key.data.key_id
}

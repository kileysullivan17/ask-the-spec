#!/usr/bin/env bash
# One-time Google Cloud setup for deploying Ask the Spec to Cloud Run from
# GitHub Actions. Run it in Google Cloud Shell (already signed in):
#
#   bash scripts/gcp-setup.sh YOUR_PROJECT_ID
#
# What it creates, all inside that one project:
#   - the APIs Cloud Run deploys need
#   - an Artifact Registry repository for the image
#   - two service accounts: a deployer (used by GitHub Actions) and a runtime
#     account (what the running service is allowed to do: read its secrets)
#   - keyless sign-in for GitHub Actions (Workload Identity Federation),
#     limited to the main branch of kileysullivan17/ask-the-spec
#   - five secrets in Secret Manager, which it asks you to paste in; input is
#     hidden and nothing is written to disk or shell history
#
# Safe to run again: anything that already exists is left alone, and a
# secret you leave blank keeps its current value.
#
# At the end it prints four values to add in GitHub as repository
# VARIABLES (not secrets): none of them is a credential.

set -euo pipefail

PROJECT_ID="${1:?Usage: bash scripts/gcp-setup.sh YOUR_PROJECT_ID}"
REGION="us-west1"
GITHUB_REPO="kileysullivan17/ask-the-spec"
AR_REPO="ask-the-spec"
DEPLOYER="ats-deployer"
RUNTIME="ats-runtime"
POOL="github"
PROVIDER="ask-the-spec"
SECRETS=(ANTHROPIC_API_KEY VOYAGE_API_KEY BANNED_NAMES LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY)

say() { printf '\n== %s\n' "$*"; }

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
DEPLOYER_SA="$DEPLOYER@$PROJECT_ID.iam.gserviceaccount.com"
RUNTIME_SA="$RUNTIME@$PROJECT_ID.iam.gserviceaccount.com"

say "Enabling APIs (takes a minute the first time)"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

say "Artifact Registry repository"
gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION" \
    --description="Ask the Spec images"

say "Service accounts"
for sa in "$DEPLOYER" "$RUNTIME"; do
  gcloud iam service-accounts describe "$sa@$PROJECT_ID.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$sa" --display-name="Ask the Spec $sa"
done

say "Deployer permissions"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOYER_SA" \
  --role=roles/run.admin --condition=None >/dev/null
gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location="$REGION" \
  --member="serviceAccount:$DEPLOYER_SA" --role=roles/artifactregistry.writer >/dev/null
# The deployer may run the service as the runtime account, and nothing else.
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --member="serviceAccount:$DEPLOYER_SA" \
  --role=roles/iam.serviceAccountUser >/dev/null

say "Keyless sign-in for GitHub Actions"
gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global \
  --workload-identity-pool="$POOL" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global \
    --workload-identity-pool="$POOL" --display-name="ask-the-spec main" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='$GITHUB_REPO' && assertion.ref=='refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository/$GITHUB_REPO" >/dev/null

say "Secrets (paste each value and press Enter; input is hidden; blank keeps the current value)"
for name in "${SECRETS[@]}"; do
  exists=no
  gcloud secrets describe "$name" >/dev/null 2>&1 && exists=yes
  label="$name"
  [ "$exists" = yes ] && label="$name (already set)"
  read -rsp "  $label: " value
  echo
  if [ -n "$value" ]; then
    [ "$exists" = yes ] || gcloud secrets create "$name" --replication-policy=automatic >/dev/null
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
    echo "    saved"
  elif [ "$exists" = no ]; then
    echo "    skipped: $name is not set, so the service will not deploy until it is"
  fi
  unset value
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    gcloud secrets add-iam-policy-binding "$name" --member="serviceAccount:$RUNTIME_SA" \
      --role=roles/secretmanager.secretAccessor >/dev/null
  fi
done
# The deploy job embeds the public spec into the image, which needs the
# Voyage key at build time. That is the only secret the deployer can read.
gcloud secrets add-iam-policy-binding VOYAGE_API_KEY --member="serviceAccount:$DEPLOYER_SA" \
  --role=roles/secretmanager.secretAccessor >/dev/null

say "Done. Add these in GitHub: repo Settings > Secrets and variables > Actions > Variables tab"
cat <<VARS

  GCP_PROJECT_ID    $PROJECT_ID
  GCP_REGION        $REGION
  GCP_WIF_PROVIDER  projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER
  GCP_DEPLOY_SA     $DEPLOYER_SA

VARS

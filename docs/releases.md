# GitHub Actions releases

`CI` runs on pull requests and pushes to `main`: install locked development dependencies, run tests, check JavaScript syntax and matching versions, and package the extension. Each run saves a ZIP and SHA256 checksum. The package allowlist in `scripts/package.mjs` excludes tests, screenshots, dependencies and credentials.

`Chrome Web Store release` runs on `v*` tags. It repeats the checks, requires the tag to match the manifest version and its commit to belong to `main`, authenticates with Google through Workload Identity Federation, uploads the ZIP with API v2, waits for processing, and submits for review with automatic publication after approval. It never cancels an existing review. Rerunning an already submitted/published version performs no write. A failed or timed-out upload never triggers publication.

The pipeline updates the extension package. Store text, screenshots, privacy declarations and visibility remain managed in the developer dashboard. A successful submission is not approval or proof that the extension is live.

## One-time publishing connection

No service-account key or refresh token is stored in GitHub. A Google Cloud project, service account and narrowly scoped workload identity provider must be configured before the release workflow can authenticate. CI and ZIP artifacts work without this connection.

Use an authenticated `gcloud` installation or Google Cloud Shell. Replace `YOUR_PROJECT_ID` with the selected project. These commands create dedicated resources; run the creation commands once. No broad project role is granted to the publishing service account.

```sh
PROJECT_ID='YOUR_PROJECT_ID'
gcloud services enable chromewebstore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"
gcloud iam service-accounts create cws-publisher --display-name='NZ Property Valuator releases' --project="$PROJECT_ID"
gcloud iam workload-identity-pools create github-property --location=global --display-name='Property GitHub releases' --project="$PROJECT_ID"
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=github-property --project="$PROJECT_ID" \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref' \
  --attribute-condition="assertion.repository_id == '1163392081' && assertion.repository_owner_id == '26684461' && assertion.sub == 'repo:reporkey/nz-property-valuator:environment:chrome-web-store' && (assertion.ref.startsWith('refs/tags/v') || assertion.ref == 'refs/heads/main') && assertion.workflow_ref == 'reporkey/nz-property-valuator/.github/workflows/release.yml@' + assertion.ref"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
CWS_ACCOUNT="cws-publisher@${PROJECT_ID}.iam.gserviceaccount.com"
POOL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-property"
gcloud iam service-accounts add-iam-policy-binding "$CWS_ACCOUNT" \
  --project="$PROJECT_ID" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL}/attribute.repository_id/1163392081"
```

In the Chrome Web Store developer dashboard, add `$CWS_ACCOUNT` under the publisher's service-account/API access setting. Google currently supports one linked service account per publisher; inspect the existing setting before replacing anything. Confirm the publisher ID there as well.

In GitHub, set these variables in the `chrome-web-store` environment (the first two store identifiers are configured during repository setup):

| Variable | Value |
| --- | --- |
| `CWS_PUBLISHER_ID` | `e18bc8a7-aaa3-4538-b214-85f91cba0cbc` |
| `CWS_EXTENSION_ID` | `pidjbcengkbcdbbbbcfcldbihoonpagl` |
| `CWS_SERVICE_ACCOUNT` | The value of `$CWS_ACCOUNT` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `$POOL/providers/github` |

```sh
gh variable set CWS_SERVICE_ACCOUNT --env chrome-web-store --repo reporkey/nz-property-valuator --body "$CWS_ACCOUNT"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --env chrome-web-store --repo reporkey/nz-property-valuator --body "$POOL/providers/github"
gh workflow run release.yml --ref main -f operation=status --repo reporkey/nz-property-valuator
```

The `status` operation reads the current store state without uploading or publishing. Verify it passes before creating a new release tag. IAM changes can take several minutes to propagate.

## Release a new version

1. Increase `manifest.json`'s version and run `npm version VERSION --no-git-tag-version` with the same version to update the package and lockfile.
2. Run `npm ci && npm run check`, commit the changes and push `main`.
3. After CI passes, create and push the matching tag, for example `git tag v1.0.4` and `git push origin v1.0.4`.
4. Check the release workflow summary and developer dashboard. `PENDING_REVIEW` means Google has received the submission; publication follows approval.

Do not tag v1.0.3 solely to test publishing: it was already submitted manually. Use the read-only status operation to verify credentials. For a rejected release, inspect Google's feedback and normally release a corrected package with a higher version.

## References

- [Chrome Web Store service accounts](https://developer.chrome.com/docs/webstore/service-accounts)
- [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api)
- [Google GitHub authentication action](https://github.com/google-github-actions/auth)

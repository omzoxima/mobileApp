# Video Streaming Platform Backend

This is a Node.js backend application that provides video streaming capabilities with PostgreSQL database. The application allows administrators to upload videos with subtitles and manages them through a series and episode structure.

## Features

- Video upload to Google Cloud Storage (GCS) (if enabled)
- Multiple subtitle track support
- Series and episode management
- Category-based organization
- PostgreSQL database integration

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL database
- Google Cloud project (for Cloud Run deployment)
- npm or yarn package manager

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables in `.env` file (for local development):
   ```env
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=video_streaming
   DB_USER=your_username
   DB_PASSWORD=your_password
   PORT=3000
   JWT_SECRET=your_jwt_secret
   # GCS/Cloud Run variables if needed
   # GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json
   # GCS_BUCKET_NAME=your-bucket-name
   ```

4. Start the server:
   ```bash
   npm start
   ```

## API Endpoints

### Upload Video (Multilingual)
- **POST** `/api/videos/upload-multilingual`
- Content-Type: multipart/form-data
- Body:
  - thumbnail: (file) Series thumbnail image
  - videos: (file[]) Video files (one per language)
  - title: (string) Episode title
  - episode_number: (number) Episode number
  - series_id: (string, optional) Series ID
  - series_title: (string, optional) Series title
  - category: (string) Category name or ID
  - reward_cost_points: (number, optional)
  - episode_description: (string, optional)
  - video_languages: (JSON string) Array of language codes (must match number of video files)

### Get Episodes by Series
- **GET** `/api/series/:seriesId/episodes`
- Returns all episodes for a specific series

### Get Series (Paginated)
- **GET** `/api/series?category=...&page=...&limit=...`
- Returns paginated series, optionally filtered by category

## Deployment: Google Cloud Run

### 1. Build and Push Docker Image
Cloud Run requires a container image. If you use GitHub Actions, this is automated (see below).

### 2. Set Environment Variables
- In Cloud Run, go to your service > Edit & Deploy New Revision > Variables & Secrets > Environment variables.
- Add all required variables (see `.env` example above). Do NOT upload your `.env` file to the repo.

### 3. GitHub Actions (CI/CD)
Add a workflow file at `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Cloud Run
on:
  push:
    branches: [ development ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - name: Set up Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '22'
    - name: Build Docker image
      run: |
        docker build -t gcr.io/$PROJECT_ID/$SERVICE_NAME:$GITHUB_SHA .
    - name: Authenticate to Google Cloud
      uses: google-github-actions/auth@v2
      with:
        credentials_json: ${{ secrets.GCP_SA_KEY }}
    - name: Push Docker image
      run: |
        gcloud auth configure-docker
        docker push gcr.io/$PROJECT_ID/$SERVICE_NAME:$GITHUB_SHA
    - name: Deploy to Cloud Run
      run: |
        gcloud run deploy $SERVICE_NAME \
          --image gcr.io/$PROJECT_ID/$SERVICE_NAME:$GITHUB_SHA \
          --region $REGION \
          --platform managed \
          --allow-unauthenticated \
          --set-env-vars PORT=3000
      env:
        PROJECT_ID: ${{ secrets.GCP_PROJECT_ID }}
        SERVICE_NAME: ${{ secrets.GCP_SERVICE_NAME }}
        REGION: ${{ secrets.GCP_REGION }}
```

- Store your Google Cloud service account key as `GCP_SA_KEY` in GitHub secrets.
- Set `GCP_PROJECT_ID`, `GCP_SERVICE_NAME`, and `GCP_REGION` as secrets too.

### 4. Dockerfile Example
Add a `Dockerfile` to your project root:

```Dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

## Using Environment Variables in Cloud Run
- Cloud Run does NOT use your `.env` file. Set all variables in the Cloud Run console or via `gcloud run deploy --set-env-vars`.
- For local development, use `.env` as usual.

## License

MIT
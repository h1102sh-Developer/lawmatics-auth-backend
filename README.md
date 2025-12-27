# USPTO Monitoring System (Vercel Deployment)

Automated monitoring of USPTO patent and trademark applications with 6-hour checks.

## Features

- ✅ **6-Hour Automatic Checks**: Monitors all matters every 6 hours
- ✅ **Instant Email Alerts**: Get notified when new documents are found
- ✅ **Google Drive Integration**: Automatically uploads documents to Drive
- ✅ **Lawmatics Integration**: Updates prospect records automatically
- ✅ **Comprehensive Dashboard**: Web interface for manual control
- ✅ **CSV Reports**: Daily reports of all matter statuses
- ✅ **Multi-Document Support**: Handles multiple documents on same date

## Deployment to Vercel

1. **Push this code to GitHub**

2. **Import to Vercel**:
   - Go to [vercel.com](https://vercel.com)
   - Click "Add New" → "Project"
   - Import your GitHub repository
   - Configure:
     - Framework Preset: "Other"
     - Build Command: (leave empty)
     - Output Directory: (leave empty)
     - Install Command: `npm install`

3. **Add Environment Variables** in Vercel dashboard:
   - Go to Project → Settings → Environment Variables
   - Add all variables from `.env.local`

4. **Deploy**:
   - Click "Deploy"
   - Your site will be live at `https://your-project.vercel.app`

## API Endpoints

- `POST /api/monitor` - Trigger manual monitoring
- `POST /api/report` - Generate and email CSV report
- `GET /api/health` - Check system health
- `GET /` - Web dashboard

## Scheduled Checks

The system automatically runs every 6 hours:
- 0:00 UTC
- 6:00 UTC  
- 12:00 UTC
- 18:00 UTC

## Email Notifications

You'll receive:
1. **Immediate alerts** when new documents are found
2. **Summary emails** after each 6-hour check
3. **Daily CSV reports** at 9:00 AM

## Manual Commands (via Dashboard)

- **Run Monitor Now**: Triggers immediate check of all matters
- **Generate Report**: Creates and emails CSV report
- **Check Health**: Verifies system status

## Local Development

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.local .env
# Edit .env with your credentials

# Run locally
npm run dev

# Test monitoring
npm run monitor

# Generate report
npm run report

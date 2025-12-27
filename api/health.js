export default async function handler(req, res) {
    res.status(200).json({
      status: 'healthy',
      service: 'USPTO Monitoring System',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      features: {
        monitoring: true,
        email_alerts: true,
        google_drive: true,
        lawmatics_integration: true,
        cron_jobs: true
      },
      schedule: {
        '6-hour_checks': 'Every 6 hours (0, 6, 12, 18 UTC)',
        daily_report: '9:00 AM daily',
        endpoints: {
          manual_trigger: 'POST /api/monitor',
          generate_report: 'POST /api/report',
          health_check: 'GET /api/health'
        }
      }
    });
  }
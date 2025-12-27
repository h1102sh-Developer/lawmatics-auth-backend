import { runJob } from '../lib/unified-uspto-monitor';

export default async function handler(req, res) {
  // This endpoint is called by Vercel Cron every 6 hours
  console.log('⏰ 6-Hour Scheduled Check Triggered');
  console.log('📅 Date:', new Date().toISOString());
  
  try {
    const result = await runJob();
    
    res.status(200).json({
      success: true,
      message: '6-hour scheduled check completed',
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Scheduled check error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
}
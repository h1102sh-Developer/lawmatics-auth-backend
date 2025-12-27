// automation-controller.js
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// Import ALL functions from the main automation file
const automation = require('./Googlecron');

// Ensure state directory exists
const stateDir = path.join(__dirname, 'state');
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
  console.log('📁 Created state directory for automation');
}

const STATUS_FILE = path.join(stateDir, 'automation-status.json');

class AutomationController {
  constructor() {
    this.cronJob = null;
    this.isRunning = false;
    this.lastRun = null;
    this.currentlyProcessing = new Set();
    this.lastStatusLog = 0;
    this.statusLogInterval = 30000; // Log status only every 30 seconds
    
    this.loadStatus();
    
    // Auto-save status periodically
    this.autoSaveInterval = setInterval(() => {
      this.saveStatus();
    }, 30000);
    
    console.log('🔄 Automation Controller initialized with persistence');
  }

  // Load status from file
  loadStatus() {
    try {
      if (fs.existsSync(STATUS_FILE)) {
        const data = fs.readFileSync(STATUS_FILE, 'utf8');
        const status = JSON.parse(data);
        
        // Restore basic state
        this.isRunning = status.running || false;
        this.lastRun = status.lastRun ? new Date(status.lastRun) : null;
        this.currentlyProcessing = new Set(status.currentlyProcessing || []);
        
        console.log('📂 Loaded automation status from file');
        console.log(`   Enabled: ${!!status.enabled}, Running: ${this.isRunning}`);
        console.log(`   Last Run: ${this.lastRun}`);
        console.log(`   Currently Processing: ${Array.from(this.currentlyProcessing).join(', ') || 'None'}`);
        
        // If automation was enabled, restart the cron job
        if (status.enabled && !this.cronJob) {
          console.log('🔄 Re-starting scheduled automation...');
          this.startScheduledAutomation();
        }
      }
    } catch (error) {
      console.error('❌ Error loading automation status:', error.message);
      this.resetToDefault();
    }
  }

  // Save status to file (with reduced logging)
  saveStatus() {
    try {
      const status = {
        enabled: !!this.cronJob,
        running: this.isRunning,
        lastRun: this.lastRun,
        currentlyProcessing: Array.from(this.currentlyProcessing),
        lastUpdated: new Date().toISOString()
      };
      
      fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
      
      // Only log state saving when something important changes
      const now = Date.now();
      if (now - this.lastStatusLog > this.statusLogInterval) {
        console.log('💾 State file updated');
        this.lastStatusLog = now;
      }
    } catch (error) {
      console.error('❌ Error saving automation status:', error.message);
    }
  }

  // Reset to default state
  resetToDefault() {
    this.cronJob = null;
    this.isRunning = false;
    this.lastRun = null;
    this.currentlyProcessing = new Set();
  }

  // Cleanup on destruction
  destroy() {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
    }
    this.saveStatus();
  }

  // Load matters from map.json
  loadMatters() {
    try {
      const mapDataPath = path.join(__dirname, 'map.json');
      if (fs.existsSync(mapDataPath)) {
        const data = fs.readFileSync(mapDataPath, 'utf8');
        const matters = JSON.parse(data);
        return matters;
      }
      console.log('⚠️ No matters found in map.json');
      return [];
    } catch (error) {
      console.error('❌ Error loading matters:', error.message);
      return [];
    }
  }

  // Update matter status in map.json (with reduced logging)
  async updateMatterStatus(lawmaticsId, status) {
    try {
      const mapDataPath = path.join(__dirname, 'map.json');
      const matters = this.loadMatters();
      
      const matterIndex = matters.findIndex(m => m.lawmaticsID === lawmaticsId);
      if (matterIndex !== -1) {
        const oldStatus = matters[matterIndex].status;
        matters[matterIndex].status = status;
        matters[matterIndex].lastUpdated = new Date().toISOString();
        
        fs.writeFileSync(mapDataPath, JSON.stringify(matters, null, 2));
        
        // Only log if status actually changed
        if (oldStatus !== status) {
          console.log(`✅ Updated matter ${lawmaticsId} status: ${oldStatus} → ${status}`);
        }
        return true;
      }
      return false;
    } catch (error) {
      console.error(`❌ Error updating matter ${lawmaticsId} status:`, error.message);
      return false;
    }
  }

  // Get specific matters by Lawmatics IDs
  getMattersByIds(lawmaticsIds) {
    const allMatters = this.loadMatters();
    return allMatters.filter(matter => lawmaticsIds.includes(matter.lawmaticsID));
  }

  // Process single matter
    // Process single matter
  async processSingleMatter(lawmaticsId) {
    if (this.currentlyProcessing.has(lawmaticsId)) {
      return { success: false, message: 'Matter is already being processed' };
    }

    try {
      this.currentlyProcessing.add(lawmaticsId);
      this.saveStatus();
      
      await this.updateMatterStatus(lawmaticsId, 'Processing...');
      
      const matters = this.getMattersByIds([lawmaticsId]);
      if (matters.length === 0) {
        await this.updateMatterStatus(lawmaticsId, 'Failed - Not Found');
        return { success: false, message: 'Matter not found' };
      }

      const matter = matters[0];
      console.log(`🚀 Processing single matter: ${matter.applicationNumber} (${matter.type})`);
      
      const lastProcessedState = await automation.loadLastProcessedState();
      const todayDate = automation.getTodayDateKey();
      
      const result = await automation.processMatter(matter, lastProcessedState, todayDate);
      
      await automation.saveLastProcessedState(lastProcessedState);
      
      this.lastRun = new Date();
      this.saveStatus();
      
      const finalStatus = result.processed ? 'Automation Completed' : 'No Updates Found';
      await this.updateMatterStatus(lawmaticsId, finalStatus);
      
      return {
        success: true,
        matter: matter,
        processed: result.processed,
        message: result.processed ? 'New document processed' : 'No new documents found'
      };
    } catch (error) {
      console.error(`❌ Error processing matter ${lawmaticsId}:`, error.message);
      await this.updateMatterStatus(lawmaticsId, 'Failed');
      return { success: false, message: error.message };
    } finally {
      this.currentlyProcessing.delete(lawmaticsId);
      this.saveStatus();
    }
  }

  // Process multiple matters
// Process multiple matters
async processMultipleMatters(lawmaticsIds) {
    const matters = this.getMattersByIds(lawmaticsIds);
    
    if (matters.length === 0) {
      return { success: false, message: 'No valid matters found' };
    }
  
    console.log(`🚀 Processing ${matters.length} matters...`);
    
    const results = [];
    const lastProcessedState = await automation.loadLastProcessedState();
    const todayDate = automation.getTodayDateKey();
  
    // Update all matters to processing status
    for (const matter of matters) {
      await this.updateMatterStatus(matter.lawmaticsID, 'Processing...');
    }
  
    let processedCount = 0;
  
    for (const matter of matters) {
      if (this.currentlyProcessing.has(matter.lawmaticsID)) {
        results.push({
          lawmaticsId: matter.lawmaticsID,
          success: false,
          message: 'Already being processed'
        });
        continue;
      }
  
      try {
        this.currentlyProcessing.add(matter.lawmaticsID);
        this.saveStatus();
        
        const result = await automation.processMatter(matter, lastProcessedState, todayDate);
        
        if (result.processed) {
          processedCount++;
        }
        
        const finalStatus = result.processed ? 'Automation Completed' : 'No Updates Found';
        await this.updateMatterStatus(matter.lawmaticsID, finalStatus);
        
        results.push({
          lawmaticsId: matter.lawmaticsID,
          success: true,
          processed: result.processed,
          applicationNumber: matter.applicationNumber,
          message: result.processed ? 'New document processed' : 'No new documents'
        });
      } catch (error) {
        console.error(`❌ Error processing matter ${matter.lawmaticsID}:`, error.message);
        await this.updateMatterStatus(matter.lawmaticsID, 'Failed');
        results.push({
          lawmaticsId: matter.lawmaticsID,
          success: false,
          message: error.message
        });
      } finally {
        this.currentlyProcessing.delete(matter.lawmaticsID);
        this.saveStatus();
      }
  
      await new Promise(r => setTimeout(r, 1000));
    }
  
    // Save the updated state after processing all matters
    await automation.saveLastProcessedState(lastProcessedState);
    
    this.lastRun = new Date();
    this.saveStatus();
    
    const successCount = results.filter(r => r.success).length;
    
    console.log(`✅ Multiple matters processing completed:`);
    console.log(`   Total: ${matters.length}, Successful: ${successCount}, New Documents: ${processedCount}`);
    
    // 🔥 ADD THIS: Send confirmation email if no new documents were found
    if (processedCount === 0) {
      try {
        console.log('📧 Sending consolidated confirmation email...');
        await automation.sendConfirmationEmail(processedCount, matters.length);
        console.log('✅ Consolidated confirmation email sent');
      } catch (emailError) {
        console.error('❌ Failed to send confirmation email:', emailError.message);
      }
    }
    
    return {
      success: true,
      total: matters.length,
      successful: successCount,
      processed: processedCount,
      results: results
    };
  }

  // Start scheduled automation
  startScheduledAutomation() {
    if (this.cronJob) {
      return { success: false, message: 'Automation is already running' };
    }

    try {
      this.cronJob = cron.schedule('*/5 * * * *', async () => {
        if (this.isRunning) {
          return;
        }

        this.isRunning = true;
        this.saveStatus();
        
        try {
          console.log('⏰ Running scheduled automation...');
          const result = await automation.processAllMatters();
          this.lastRun = new Date();
          console.log(`✅ Scheduled automation completed: ${result.processed} new documents`);
        } catch (error) {
          console.error('❌ Error in scheduled automation:', error.message);
        } finally {
          this.isRunning = false;
          this.saveStatus();
        }
      }, {
        scheduled: true,
        timezone: "America/New_York"
      });

      console.log('✅ Scheduled automation started (runs every 5 minutes)');
      this.saveStatus();
      return { success: true, message: 'Automation started' };
    } catch (error) {
      console.error('❌ Error starting scheduled automation:', error.message);
      return { success: false, message: error.message };
    }
  }

  // Stop scheduled automation
  stopScheduledAutomation() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log('🛑 Scheduled automation stopped');
      this.saveStatus();
      return { success: true, message: 'Automation stopped' };
    }
    return { success: false, message: 'Automation was not running' };
  }

  // Run automation once (all matters)
  async runAutomationOnce() {
    if (this.isRunning) {
      return { success: false, message: 'Automation is already running' };
    }

    this.isRunning = true;
    this.saveStatus();
    
    try {
      console.log('🔃 Running automation once (all matters)...');
      const result = await automation.processAllMatters();
      this.lastRun = new Date();
      
      console.log(`✅ Manual automation completed: ${result.processed} new documents out of ${result.total} matters`);
      this.saveStatus();
      
      return {
        success: true,
        processed: result.processed,
        total: result.total,
        message: `Processed ${result.processed} new documents out of ${result.total} matters`
      };
    } catch (error) {
      console.error('❌ Error running automation once:', error.message);
      this.saveStatus();
      return { success: false, message: error.message };
    } finally {
      this.isRunning = false;
      this.saveStatus();
    }
  }

  // Get automation status (with reduced logging)
  getStatus() {
    const now = Date.now();
    const shouldLog = now - this.lastStatusLog > this.statusLogInterval;
    
    const status = {
      enabled: !!this.cronJob,
      running: this.isRunning,
      lastRun: this.lastRun,
      currentlyProcessing: Array.from(this.currentlyProcessing),
      serverTime: new Date().toISOString()
    };
    
    // Only log status periodically to reduce noise
    if (shouldLog && (status.enabled || status.running || status.currentlyProcessing.length > 0)) {
      console.log('📊 Automation status:', {
        enabled: status.enabled,
        running: status.running,
        processingCount: status.currentlyProcessing.length
      });
      this.lastStatusLog = now;
    }
    
    return status;
  }

  // Get all matters with their current status
  getAllMattersStatus() {
    const matters = this.loadMatters();
    return matters.map(matter => ({
      applicationNumber: matter.applicationNumber,
      lawmaticsID: matter.lawmaticsID,
      type: matter.type,
      status: matter.status || 'Pending Automation',
      lastUpdated: matter.lastUpdated || null,
      isProcessing: this.currentlyProcessing.has(matter.lawmaticsID)
    }));
  }
}

// Create and export the instance
const automationController = new AutomationController();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down automation controller...');
  automationController.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down automation controller...');
  automationController.destroy();
  process.exit(0);
});


module.exports = automationController;

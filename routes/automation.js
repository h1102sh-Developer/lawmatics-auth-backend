// routes/automation.js
const express = require('express');
const router = express.Router();
const automationController = require('../automation-controller');

// Get automation status
router.get('/status', (req, res) => {
  res.json(automationController.getStatus());
});

// Start scheduled automation
router.post('/start', (req, res) => {
  const result = automationController.startScheduledAutomation();
  res.json(result);
});

// Stop scheduled automation
router.post('/stop', (req, res) => {
  const result = automationController.stopScheduledAutomation();
  res.json(result);
});

// Run automation once (all matters)
router.post('/run-once', async (req, res) => {
  try {
    const result = await automationController.runAutomationOnce();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Process single matter
router.post('/process-single', async (req, res) => {
  try {
    const { lawmaticsId } = req.body;
    if (!lawmaticsId) {
      return res.status(400).json({ success: false, message: 'Lawmatics ID is required' });
    }

    const result = await automationController.processSingleMatter(lawmaticsId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Process multiple matters
router.post('/process-multiple', async (req, res) => {
  try {
    const { lawmaticsIds } = req.body;
    if (!lawmaticsIds || !Array.isArray(lawmaticsIds) || lawmaticsIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Lawmatics IDs array is required' });
    }

    const result = await automationController.processMultipleMatters(lawmaticsIds);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
// unified-uspto-monitor.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { parseStringPromise } = require('xml2js');
const { uploadToDrive } = require('./googleDrive');
const sgMail = require('@sendgrid/mail');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');

// ========================
// 🛠️ INITIAL SETUP
// ========================
// Create tmp directory if it doesn't exist
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
  console.log('📁 Created tmp directory');
}

// Create state directory for tracking last processed dates
const stateDir = path.join(__dirname, 'state');
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
  console.log('📁 Created state directory');
}

// State file to track last processed dates
const STATE_FILE = path.join(stateDir, 'lastProcessedState.json');

// Load application mapping with absolute path
const mapDataPath = path.join(__dirname, 'map.json');
if (!fs.existsSync(mapDataPath)) {
  console.error('❌ map.json file not found!');
  process.exit(1);
}

// Form configuration
const FORM_URL = "https://app.lawmatics.com/forms/update-by-id/d2ab9a6a-2800-41f3-a4ba-51feedbf02b3";
const LAW_TOKEN = process.env.LAW_TOKEN;

// Validate environment variables
const requiredEnvVars = ['EMAIL_USER', 'EMAIL_PASS', 'EMAIL_TO', 'GDRIVE_FOLDER_ID'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing environment variables:', missingEnvVars.join(', '));
  process.exit(1);
}

// Email setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ========================
// 📅 DATE TRACKING FUNCTIONS
// ========================

/**
 * Load last processed state
 */
async function loadLastProcessedState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = await fs.promises.readFile(STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("❌ Error loading state file:", error.message);
  }
  return {};
}

/**
 * Save last processed state
 */
async function saveLastProcessedState(state) {
  try {
    await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('💾 State file updated');
  } catch (error) {
    console.error("❌ Error saving state file:", error.message);
  }
}

/**
 * Get today's date in YYYY-MM-DD format (for daily cycle)
 */
function getTodayDateKey() {
  const now = new Date();
  return now.toISOString().split('T')[0]; // Returns YYYY-MM-DD
}

/**
 * Check if document is new (from today or newer than last processed date)
 */
function isNewDocument(docDate, lastProcessedDate, todayDate) {
  const docDateStr = docDate.toISOString().split('T')[0];
  
  // If we have a last processed date, compare with that
  if (lastProcessedDate) {
    // Only process if the document date is STRICTLY newer than last processed
    // This prevents reprocessing the same document
    return docDateStr > lastProcessedDate;
  }
  
  // Otherwise, only process documents from today or future
  return docDateStr >= todayDate;
}
// ========================
// 🔧 Core Functions
// ========================

/**
 * Load matter mapping from map.json
 */
async function loadMatterMap() {
  try {
    const data = await fs.promises.readFile(mapDataPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error("❌ Error loading map.json:", error.message);
    return [];
  }
}

/**
 * Fetch latest Trademark document from USPTO API
 */
async function fetchTrademarkDoc(applicationNumber) {
  try {
    const url = `https://tsdrapi.uspto.gov/ts/cd/casedocs/bundle.xml?sn=${applicationNumber}`;
    
    console.log(`🔍 Fetching trademark data for ${applicationNumber}...`);
    
    const { data } = await axios.get(url, {
      headers: { 
        'USPTO-API-KEY': process.env.USPTO_API_KEY || '5WFZ8ApIfVK4ZZKevqIGFn0WtgLVmw4w'
      },
      timeout: 15000
    });

    const result = await parseStringPromise(data);
    const docs = result?.DocumentList?.Document || [];

    if (docs.length === 0) {
      console.log(` No trademark documents found for application ${applicationNumber}`);
      return null;
    }

    const parsedDocs = docs
      .map((doc) => {
        const rawDate = doc.MailRoomDate?.[0] || doc.ScanDateTime?.[0] || "";
        const cleanedDate = rawDate.replace(/-\d{2}:\d{2}$/, "");
        const dateObj = new Date(cleanedDate);

        return {
          date: isNaN(dateObj) ? null : dateObj,
          description: doc.DocumentTypeDescriptionText?.[0] || "Unknown",
          link: doc.UrlPathList?.[0]?.UrlPath?.[0] || "N/A",
        };
      })
      .filter((doc) => doc.date !== null)
      .sort((a, b) => b.date - a.date);

    console.log(`✅ Found ${parsedDocs.length} trademark documents for ${applicationNumber}`);
    return parsedDocs[0];
  } catch (error) {
    console.error(`❌ Error fetching trademark doc for ${applicationNumber}:`, error.message);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Response: ${JSON.stringify(error.response.data)}`);
    }
    return null;
  }
}

/**
 * Fetch latest Patent document from USPTO API
 */
async function fetchPatentDoc(applicationNumber) {
  try {
    const url = `https://api.uspto.gov/api/v1/patent/applications/${encodeURIComponent(
      applicationNumber
    )}/documents`;

    console.log(`🔍 Fetching patent data for ${applicationNumber}...`);
    
    const { data } = await axios.get(url, {
      headers: {
        accept: "application/json",
        "X-API-KEY": process.env.USPTO_API_KEY || "wbrvfnkztibwvbguoheyakqjlhgagv",
      },
      timeout: 15000,
    });

    const docs = data?.documentBag || [];
    if (docs.length === 0) {
      console.log(` No patent documents found for application ${applicationNumber}`);
      return null;
    }

    const sortedDocs = docs
      .map((doc) => ({
        date: new Date(doc.officialDate),
        description: doc.documentCodeDescriptionText || "Unknown",
        documentCode: doc.documentCode || "N/A",
        category: doc.directionCategory || "N/A",
        link: doc.downloadOptionBag?.[0]?.downloadUrl || "N/A",
      }))
      .filter((doc) => !isNaN(doc.date))
      .sort((a, b) => b.date - a.date);

    console.log(`✅ Found ${sortedDocs.length} patent documents for ${applicationNumber}`);
    return sortedDocs[0];
  } catch (error) {
    console.error(`❌ Error fetching patent doc for ${applicationNumber}:`, error.message);
    return null;
  }
}

/**
 * Download and upload document to Google Drive
 */
async function downloadAndUploadToDrive(applicationNumber, latestDoc, type) {
  if (!latestDoc.link || latestDoc.link === 'N/A') {
    return latestDoc;
  }

  try {
    console.log(`📥 Downloading ${type} document for ${applicationNumber}`);
    
    let response;
    if (type === "Patent") {
      // Use proxy for patent documents to handle authentication
      const proxyUrl = `https://lawmatics-backend.onrender.com/api/patent/download?url=${encodeURIComponent(latestDoc.link)}`;
      response = await axios.get(proxyUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });
    } else {
      // Direct download for trademarks
      response = await axios.get(latestDoc.link, { 
        responseType: 'arraybuffer',
        timeout: 30000 
      });
    }
    
    const fileName = `${applicationNumber}-${latestDoc.description.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const filePath = path.join(tmpDir, fileName);
    
    fs.writeFileSync(filePath, response.data);

    console.log(`📤 Uploading to Google Drive: ${fileName}`);
    const driveRes = await uploadToDrive(
      filePath,
      fileName,
      process.env.GDRIVE_FOLDER_ID
    );

    console.log(`📂 Uploaded ${type} doc to Drive: ${driveRes.webViewLink}`);
    
    // Update the link to use Google Drive URL
    const updatedDoc = { ...latestDoc, driveLink: driveRes.webViewLink };
    
    // Clean up local file
    fs.unlinkSync(filePath);
    
    return updatedDoc;
  } catch (err) {
    console.error(`❌ Drive upload failed (${type}):`, err.message);
    return latestDoc; // Return original doc if upload fails
  }
}

/**
 * Get prospect data from Lawmatics API
 */
async function getProspect(lawmaticsID) {
  try {
    const { data } = await axios.get(
      `https://api.lawmatics.com/v1/prospects/${lawmaticsID}?fields=all`,
      { 
        headers: { Authorization: LAW_TOKEN },
        timeout: 10000 
      }
    );
    return data.data.attributes;
  } catch (err) {
    console.error(`❌ Failed to prospect ${lawmaticsID}:`, err?.response?.data || err.message);
    return null;
  }
}

/**
 * Update Prospect in Lawmatics (API method)
 */
async function updateLawmaticsProspect(lawmaticsID, applicationNumber, latestDoc, type) {
  try {
    const docUrl = latestDoc.driveLink || latestDoc.link || "N/A";

    const payload = {
      notes: [
        {
          name: "USPTO Update",
          body: `Document Type: ${latestDoc.description}
Mailroom Date: ${latestDoc.date.toISOString().split("T")[0]}
Download Link: ${docUrl}`,
        },
      ],
      custom_fields: [
        { id: "31473", value: applicationNumber },
        { id: "549382", value: latestDoc.date.toISOString().split("T")[0] },
        { id: "624707", value: latestDoc.description },
        { id: "633940", value: latestDoc.documentCode || "N/A" },
        { id: "624715", value: latestDoc.category || "N/A" },
        { id: "654950", value: docUrl },
      ],
    };

    await axios.put(
      `https://api.lawmatics.com/v1/prospects/${lawmaticsID}`,
      payload,
      { 
        headers: { 
          Authorization: LAW_TOKEN, 
          "Content-Type": "application/json" 
        },
        timeout: 10000
      }
    );

    console.log(`✅ Prospect ${lawmaticsID} updated for ${type} #${applicationNumber}`);
  } catch (error) {
    console.error(`❌ Prospect PUT failed for ${applicationNumber}:`, error?.response?.data || error.message);
  }
}

// ========================
// 📝 Form Automation (Puppeteer)
// ========================

/**
 * Helper function to safely clear and type into a field
 */
async function safeClearAndType(page, selector, value, timeout = 5000) {
  try {
    await page.waitForSelector(selector, { timeout, visible: true });
    
    // Focus on the field
    await page.click(selector);
    
    // Multiple methods to clear the field
    try {
      // Method 1: Select all text and delete
      await page.click(selector, { clickCount: 3 });
      await page.keyboard.press('Backspace');
    } catch (error) {
      // Method 2: Use keyboard shortcuts (Ctrl+A or Cmd+A)
      const isMac = await page.evaluate(() => navigator.platform.toLowerCase().includes('mac'));
      const modifierKey = isMac ? 'Meta' : 'Control';
      
      await page.keyboard.down(modifierKey);
      await page.keyboard.press('a');
      await page.keyboard.up(modifierKey);
      await page.keyboard.press('Backspace');
    }
    
    // Wait a bit to ensure field is cleared
    await new Promise(r => setTimeout(r, 300));
    
    // Method 3: Directly set the value via JavaScript as fallback
    const currentValue = await page.$eval(selector, el => el.value);
    if (currentValue) {
      await page.evaluate((sel) => {
        document.querySelector(sel).value = '';
      }, selector);
    }
    
    // Type new value character by character with small delays
    await page.type(selector, value, { delay: 50 });
    
    // Verify the value was set correctly
    const finalValue = await page.$eval(selector, el => el.value);
    if (finalValue !== value) {
      console.warn(` Value mismatch for ${selector}. Expected: ${value}, Got: ${finalValue}`);
      // Try one more time with direct JavaScript
      await page.evaluate((sel, val) => {
        document.querySelector(sel).value = val;
      }, selector, value);
    }
    
    return true;
  } catch (error) {
    console.warn(` Field not found or error clearing: ${selector}`, error.message);
    return false;
  }
}

/**
 * Submit Lawmatics form with real USPTO data using Puppeteer
 */
// async function submitFormWithPuppeteer(matterId, applicationNumber, latestDoc, type, prospectData) {
//   // const browser = await puppeteer.launch({ 
//   //   headless: process.env.NODE_ENV === 'production' ? true : false 
//   // });
//   const browser = await puppeteer.launch({
//   headless: true,
//   args: [
//     '--no-sandbox',
//     '--disable-setuid-sandbox',
//     '--disable-dev-shm-usage',
//     '--disable-gpu',
//     '--no-zygote',
//     '--single-process'
//   ]
// });

//   const page = await browser.newPage();

async function submitFormWithPuppeteer(matterId, applicationNumber, latestDoc, type, prospectData) {
  let browser = null;
  
  try {
    // Launch browser for Render
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    console.log(` Opening Lawmatics form for ${type} #${applicationNumber}...`);
    await page.goto(FORM_URL, { waitUntil: "networkidle2" });

    // Step 1: Enter Matter ID
    await page.waitForSelector("#id", { visible: true, timeout: 10000 });
    await safeClearAndType(page, "#id", matterId);

    // Step 2: Click "Find Matter"
    await page.click('button[type="submit"]');
    console.log("⏳ Waiting for Lawmatics to fetch matter details...");
    await new Promise(r => setTimeout(r, 15000));

    // Step 3: Fill USPTO fields using the correct selectors
    console.log(" Filling USPTO details...");
    
    // Use Google Drive link if available, otherwise use original link
    const documentLink = latestDoc.driveLink || latestDoc.link || "";
    
    // Define all fields to fill
    const fieldsToFill = [
      {
        selector: 'input[name="RmllbGRzOjpDdXN0b21GaWVsZC1DdXN0b21GaWVsZDo6UHJvc3BlY3QtMzE0NzM="]',
        value: applicationNumber,
        description: "Application Number"
      },
      {
        selector: 'input[name="RmllbGRzOjpDdXN0b21GaWVsZC1DdXN0b21GaWVsZDo6UHJvc3BlY3QtNTQ5Mzgy"]',
        value: latestDoc.date ? latestDoc.date.toISOString().split("T")[0] : "",
        description: "Mailroom Date"
      },
      {
        selector: 'input[name="RmllbGRzOjpDdXN0b21GaWVsZC1DdXN0b21GaWVsZDo6UHJvc3BlY3QtNjI0NzA3"]',
        value: latestDoc.description || "",
        description: "Document Description"
      },
      {
        selector: 'input[name="RmllbGRzOjpDdXN0b21GaWVsZC1DdXN0b21GaWVsZDo6UHJvc3BlY3QtNjMzOTM5"]',
        value: latestDoc.description || "",
        description: "Patent Document Description"
      },
      {
        selector: 'input[name="Q3VzdG9tRm9ybUNvbXBvbmVudDo6QWR2YW5jZWQtZ2VuZXJhbF9maWVsZC1lOWYxN2U2Zi03YTU0LTQ1YTMtYjNjYS1hMDcxMzAzMjcyZDQ="]',
        value: documentLink,
        description: "File/Document Link (Google Drive)"
      }
    ];

    // Add patent-specific fields if it's a patent
    if (type === "Patent") {
      fieldsToFill.push(
        {
          selector: 'input[name="RmllbGRzOjpDdXN0b21GaWVsZC1DdXN0b21GaWVsZDo6UHJvc3BlY3QtNjMzOTQw"]',
          value: (latestDoc.documentCode && latestDoc.documentCode !== "N/A") ? latestDoc.documentCode : "",
          description: "Patent Document Code"
        },
        {
          selector: 'input[name="RmllbGRzOjpDdXN0b21GaWVsZC1DdXN0b21GaWVsZDo6UHJvc3BlY3QtNjI0NzE1"]',
          value: (latestDoc.category && latestDoc.category !== "N/A") ? latestDoc.category : "",
          description: "Category"
        }
      );
    }

    // Fill all fields
    for (const field of fieldsToFill) {
      if (field.value) {
        console.log(`   Filling ${field.description}...`);
        await safeClearAndType(page, field.selector, field.value);
        await new Promise(r => setTimeout(r, 300)); // Small delay between fields
      }
    }

    // Step 4: Submit
    console.log("📩 Submitting form...");
    try {
      await page.waitForSelector('button[type="button"]', { visible: true, timeout: 10000 });
      await page.click('button[type="button"]');
      console.log(`✅ Form submitted for ${type} #${applicationNumber}`);
    } catch (submitError) {
      console.log(" Trying alternative submit button selector...");
      await page.waitForSelector('div[data-cy="Submit-button"]', { visible: true, timeout: 5000 });
      await page.click('div[data-cy="Submit-button"]');
      console.log(`✅ Form submitted for ${type} #${applicationNumber}`);
    }

    await new Promise(r => setTimeout(r, 5000));
  } catch (err) {
    console.error(`❌ Puppeteer submission failed for ${applicationNumber}:`, err.message);
  } finally {
    await browser.close();
  }
}

// ========================
// 📧 Email Notification
// ========================

/**
 * Send email notification for new document
 */
// async function sendEmailNotification(applicationNumber, latestDoc, type) {
//   const docUrl = latestDoc.driveLink || latestDoc.link || "N/A";
  
//   await transporter.sendMail({
//     from: process.env.EMAIL_USER,
//     to: process.env.EMAIL_TO,
//     subject: `New ${latestDoc.description} for ${type} #${applicationNumber}`,
//     html: `
//       <h4>Latest Document for ${type} #${applicationNumber}</h4>
//       <ul>
//         <li><strong>Date:</strong> ${latestDoc.date.toISOString().split('T')[0]}</li>
//         <li><strong>Type:</strong> ${latestDoc.description}</li>
//         ${type === "Patent" ? `
//           <li><strong>Code:</strong> ${latestDoc.documentCode}</li>
//           <li><strong>Category:</strong> ${latestDoc.category}</li>
//         ` : ''}
//         <li><strong>Link:</strong> ${docUrl !== "N/A" ? `<a href="${docUrl}">View Document</a>` : "No Link Available"}</li>
//         ${latestDoc.driveLink ? `<li><strong>Storage:</strong> Google Drive</li>` : ''}
//       </ul>
//       <p>This is an automated update from USPTO ${type} API.</p>
//     `,
//   });

//   console.log(`📩 Email sent for ${type} ${applicationNumber}`);
// }

/**
 * Send email notification for new document (SendGrid only)
 */
async function sendEmailNotification(applicationNumber, latestDoc, type) {
  const docUrl = latestDoc.driveLink || latestDoc.link || "N/A";
  
  try {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    
    await sgMail.send({
      from: 'automations@inspiredideasolutions.com',
      to: 'automations@inspiredideasolutions.com',
      subject: `New ${latestDoc.description} for ${type} #${applicationNumber}`,
      html: `
        <h4>Latest Document for ${type} #${applicationNumber}</h4>
        <ul>
          <li><strong>Date:</strong> ${latestDoc.date.toISOString().split('T')[0]}</li>
          <li><strong>Type:</strong> ${latestDoc.description}</li>
          ${type === "Patent" ? `
            <li><strong>Code:</strong> ${latestDoc.documentCode}</li>
            <li><strong>Category:</strong> ${latestDoc.category}</li>
          ` : ''}
          <li><strong>Link:</strong> ${docUrl !== "N/A" ? `<a href="${docUrl}">View Document</a>` : "No Link Available"}</li>
          ${latestDoc.driveLink ? `<li><strong>Storage:</strong> Google Drive</li>` : ''}
        </ul>
        <p>This is an automated update from USPTO ${type} API.</p>
      `,
    });

    console.log(`📩 Email sent for ${type} ${applicationNumber}`);
  } catch (error) {
    console.error('❌ Email failed:', error.message);
  }
}
// /**
//  * Send confirmation email when all matters are up to date
//  */
// async function sendConfirmationEmail(processedCount, totalCount) {
//   await transporter.sendMail({
//     from: process.env.EMAIL_USER,
//     to: process.env.EMAIL_TO,
//     subject: `USPTO Monitor: All Matters Up to Date`,
//     html: `
//       <h4>USPTO Monitoring Complete</h4>
//       <p>All matters have been checked and are up to date.</p>
//       <ul>
//         <li><strong>Total Matters Checked:</strong> ${totalCount}</li>
//         <li><strong>New Documents Found:</strong> ${processedCount}</li>
//         <li><strong>Timestamp:</strong> ${new Date().toISOString()}</li>
//       </ul>
//       <p>Next check will run at the scheduled time.</p>
//     `,
//   });

//   console.log(`📩 Confirmation email sent - ${processedCount} new documents out of ${totalCount} matters`);
// }


async function sendConfirmationEmail(processedCount, totalCount) {
  try {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    
    await sgMail.send({
      from: 'automations@inspiredideasolutions.com',
      to: 'automations@inspiredideasolutions.com',
      subject: `USPTO Monitor: All Matters Up to Date`,
      html: `
        <h4>USPTO Monitoring Complete</h4>
        <p>All matters have been checked and are up to date.</p>
        <ul>
          <li><strong>Total Matters Checked:</strong> ${totalCount}</li>
          <li><strong>New Documents Found:</strong> ${processedCount}</li>
          <li><strong>Timestamp:</strong> ${new Date().toISOString()}</li>
        </ul>
        <p>Next check will run at the scheduled time.</p>
      `,
    });

    console.log(`📩 Confirmation email sent - ${processedCount} new documents out of ${totalCount} matters`);
  } catch (error) {
    console.error('❌ Email failed:', error.message);
  }
}
// ========================
// 🚀 Main Processing Functions
// ========================

/**
 * Process a single matter with date filtering
 */
async function processMatter(matter, lastProcessedState, todayDate) {
  const { applicationNumber, lawmaticsID, type } = matter;
  
  console.log(`\n🔹 Processing ${type} #${applicationNumber} (Lawmatics ID: ${lawmaticsID})...`);

  let latestDoc = null;
  if (type === "Patent") {
    latestDoc = await fetchPatentDoc(applicationNumber);
  } else if (type === "Trademark") {
    latestDoc = await fetchTrademarkDoc(applicationNumber);
  } else {
    console.error(`❌ Unknown type: ${type} for application ${applicationNumber}`);
    return { processed: false, reason: 'unknown_type' };
  }

  if (!latestDoc) {
    console.log(`⏭️ Skipping ${type} #${applicationNumber} - no documents found`);
    return { processed: false, reason: 'no_documents' };
  }

  // Check if this document is new
  const lastProcessedDate = lastProcessedState[applicationNumber];
  const docDateStr = latestDoc.date.toISOString().split('T')[0];
  const isNew = isNewDocument(latestDoc.date, lastProcessedDate, todayDate);

  if (!isNew) {
    console.log(`⏭️ Skipping ${type} #${applicationNumber} - document date ${docDateStr} is not new (last processed: ${lastProcessedDate || 'never'})`);
    return { processed: false, reason: 'not_new', docDate: latestDoc.date };
  }

  console.log(`🆕 NEW document found for ${type} #${applicationNumber}:`);
  console.log(`   Date: ${docDateStr}`);
  console.log(`   Description: ${latestDoc.description}`);
  if (latestDoc.documentCode) console.log(`   Document Code: ${latestDoc.documentCode}`);
  if (latestDoc.category) console.log(`   Category: ${latestDoc.category}`);
  console.log(`   Link: ${latestDoc.link}`);

  // Download and upload to Google Drive
  latestDoc = await downloadAndUploadToDrive(applicationNumber, latestDoc, type);

  // Send email notification
  await sendEmailNotification(applicationNumber, latestDoc, type);

  // Update Lawmatics via API
  await updateLawmaticsProspect(lawmaticsID, applicationNumber, latestDoc, type);

  // Get prospect data and submit form via Puppeteer
  const prospectData = await getProspect(lawmaticsID);
  if (prospectData) {
    await submitFormWithPuppeteer(lawmaticsID, applicationNumber, latestDoc, type, prospectData);
  } else {
    console.log(`⚠️ Could not fetch prospect data for ${lawmaticsID}, skipping form submission`);
  }

  // ✅ CRITICAL FIX: Update with the ACTUAL document date, not today's date
  lastProcessedState[applicationNumber] = docDateStr; // ← Store document date, not today's date

  return { processed: true, docDate: latestDoc.date };
}

/**
 * Main function to process all matters with date filtering
 */
async function processAllMatters() {
  try {
    const matters = await loadMatterMap();
    const lastProcessedState = await loadLastProcessedState();
    const todayDate = getTodayDateKey();
    
    if (matters.length === 0) {
      console.log("❌ No matters found in map.json");
      return;
    }

    console.log(`📋 Found ${matters.length} matters to process`);
    console.log(`📅 Today's date: ${todayDate}`);
    
    // Check if USPTO API key is available
    if (!process.env.USPTO_API_KEY) {
      console.warn("⚠️ USPTO_API_KEY environment variable not set. Using default key which may have rate limits.");
    }
    
    let processedCount = 0;
    const results = [];
    
    // Process each matter sequentially
    for (const matter of matters) {
      const result = await processMatter(matter, lastProcessedState, todayDate);
      results.push({ ...matter, ...result });
      
      if (result.processed) {
        processedCount++;
      }
      
      // Add a small delay between processing matters
      await new Promise(r => setTimeout(r, 2000));
    }
    
    // Save the updated state
    await saveLastProcessedState(lastProcessedState);
    
    // Log summary
    console.log(`\n📊 PROCESSING SUMMARY:`);
    console.log(`   Total matters: ${matters.length}`);
    console.log(`   New documents processed: ${processedCount}`);
    console.log(`   Skipped (no new docs): ${matters.length - processedCount}`);
    
    // Send confirmation email if no new documents were found
    if (processedCount === 0) {
      await sendConfirmationEmail(processedCount, matters.length);
      console.log('✅ All matters are up to date - confirmation email sent');
    } else {
      console.log(`🎉 Processed ${processedCount} new documents successfully!`);
    }
    
  } catch (error) {
    console.error("❌ Error in main process:", error.message);
  }
}

// ========================
// 📅 CRON SCHEDULE & MANUAL EXECUTION
// ========================

/**
 * Run the monitoring job (for cron)
 */
const runJob = async () => {
  console.log('⏰ Running scheduled job at', new Date().toISOString());
  await processAllMatters();
  console.log('✅ Job completed successfully at', new Date().toISOString());
};

// Start the service
console.log('🚀 Starting Unified USPTO Monitoring Service...');

// Load and display applications to monitor
const mapData = JSON.parse(fs.readFileSync(mapDataPath, 'utf-8'));
console.log('📊 Applications to monitor:', mapData.length);

// Run daily at 12:00 PM (adjust timezone as needed)
cron.schedule('0 12 * * *', runJob, {
  timezone: "America/New_York" // Adjust to your timezone
});

console.log('⏰ Scheduled job set to run daily at 12:00 PM');

// Run immediately on launch if needed (for testing)
if (process.argv.includes('--run-now')) {
  console.log('🔄 Running initial check...');
  runJob().catch(console.error);
}

// Export for manual execution if needed
// module.exports = { processAllMatters, runJob };
// ========================
// 📤 EXPORTS
// ========================
// ========================
// 🐛 DEBUG FUNCTIONS
// ========================

/**
 * Reset state for specific applications (for debugging)
 */
async function resetApplicationState(applicationNumber) {
  const lastProcessedState = await loadLastProcessedState();
  if (lastProcessedState[applicationNumber]) {
    delete lastProcessedState[applicationNumber];
    await saveLastProcessedState(lastProcessedState);
    console.log(`✅ Reset state for application ${applicationNumber}`);
  }
}

/**
 * View current state for debugging
 */
async function viewApplicationState(applicationNumber) {
  const lastProcessedState = await loadLastProcessedState();
  console.log(`📊 State for ${applicationNumber}:`, lastProcessedState[applicationNumber] || 'never processed');
}

// ========================
// 🧪 DEBUG COMMANDS
// ========================

if (process.argv.includes('--reset-state')) {
  const appNumber = process.argv[process.argv.indexOf('--reset-state') + 1];
  (async () => {
    await resetApplicationState(appNumber);
    process.exit(0);
  })();
}

if (process.argv.includes('--view-state')) {
  const appNumber = process.argv[process.argv.indexOf('--view-state') + 1];
  (async () => {
    await viewApplicationState(appNumber);
    process.exit(0);
  })();
}
// ========================
// 🧪 TEST MODE: Single Matter Full Run
// ========================
if (process.argv.includes('--test-one')) {
  const appNumber = process.argv[process.argv.indexOf('--test-one') + 1];
  (async () => {
    console.log(`🧪 Running full test for application ${appNumber}...`);

    try {
      // 1️⃣ Load all matters
      const allMatters = await loadMatterMap();
      const matter = allMatters.find(m => m.applicationNumber === appNumber);
      if (!matter) {
        console.error(`❌ Matter ${appNumber} not found in map.json`);
        process.exit(1);
      }

      // 2️⃣ Use REAL state, not fake state
      const lastProcessedState = await loadLastProcessedState();
      const todayDate = getTodayDateKey();

      console.log(`📊 Current state for ${appNumber}:`, lastProcessedState[appNumber] || 'never processed');

      // 3️⃣ Run the main process for this matter
      const result = await processMatter(matter, lastProcessedState, todayDate);

      // 4️⃣ ✅ SAVE THE STATE in test mode too!
      await saveLastProcessedState(lastProcessedState);

      console.log('✅ Full process test completed successfully.');
      console.log('Result:', result);
      console.log(`📊 New state for ${appNumber}:`, lastProcessedState[appNumber]);
    } catch (err) {
      console.error('❌ Test run failed:', err);
    } finally {
      process.exit(0);
    }
  })();
}
// ========================
// 🛡️ GRACEFUL SHUTDOWN HANDLING
// ========================

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM. Shutting down gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  // Don't exit - let the process continue running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - let the process continue running
});
module.exports = {
  // Main processing functions
  processMatter,
  processAllMatters,
  runJob,
  
  // Date tracking functions
  loadLastProcessedState,
  saveLastProcessedState,
  getTodayDateKey,
  isNewDocument,
  
  // Core API functions
  fetchPatentDoc,
  fetchTrademarkDoc,
  downloadAndUploadToDrive,
  getProspect,
  updateLawmaticsProspect,
  submitFormWithPuppeteer,
  sendEmailNotification,
  sendConfirmationEmail,
  
  // Utility functions
  loadMatterMap,
  safeClearAndType,
  
  // Debug functions
  resetApplicationState,
  viewApplicationState
};








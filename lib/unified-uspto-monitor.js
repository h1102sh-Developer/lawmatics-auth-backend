const path = require('path');
require('dotenv').config();
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { parseStringPromise } = require('xml2js');
const puppeteer = require("puppeteer");
const { uploadToDrive } = require('./googleDrive');

// ========================
// 🛠️ INITIAL SETUP
// ========================
// Create tmp directory if it doesn't exist
const tmpDir = path.join(__dirname, '../tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
  console.log('📁 Created tmp directory');
}

// Create state directory for tracking last processed dates
const stateDir = path.join(__dirname, '../state');
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
  console.log('📁 Created state directory');
}

// State file to track last processed dates
const STATE_FILE = path.join(stateDir, 'lastProcessedState.json');

// Load application mapping with absolute path
const mapDataPath = path.join(__dirname, '../map.json');
if (!fs.existsSync(mapDataPath)) {
  console.error('❌ map.json file not found!');
  process.exit(1);
}

// Form configuration
const FORM_URL = "https://app.lawmatics.com/forms/update-by-id/d2ab9a6a-2800-41f3-a4ba-51feedbf02b3";
const LAW_TOKEN = process.env.LAW_TOKEN;

// Multi-document configuration
const SUBMISSION_DELAY_MS = 5000; // 5 seconds delay between submissions

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
 * Fetch ALL Trademark documents from USPTO API (not just latest)
 */
async function fetchAllTrademarkDocs(applicationNumber) {
  try {
    const url = `https://tsdrapi.uspto.gov/ts/cd/casedocs/bundle.xml?sn=${applicationNumber}`;
    
    console.log(`🔍 Fetching ALL trademark data for ${applicationNumber}...`);
    
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
      return [];
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
    return parsedDocs;
  } catch (error) {
    console.error(`❌ Error fetching trademark docs for ${applicationNumber}:`, error.message);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Response: ${JSON.stringify(error.response.data)}`);
    }
    return [];
  }
}

/**
 * Fetch ALL Patent documents from USPTO API (not just latest)
 */
async function fetchAllPatentDocs(applicationNumber) {
  try {
    const url = `https://api.uspto.gov/api/v1/patent/applications/${encodeURIComponent(
      applicationNumber
    )}/documents`;

    console.log(`🔍 Fetching ALL patent data for ${applicationNumber}...`);
    
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
      return [];
    }

    const parsedDocs = docs
      .map((doc) => ({
        date: new Date(doc.officialDate),
        description: doc.documentCodeDescriptionText || "Unknown",
        documentCode: doc.documentCode || "N/A",
        category: doc.directionCategory || "N/A",
        link: doc.downloadOptionBag?.[0]?.downloadUrl || "N/A",
      }))
      .filter((doc) => !isNaN(doc.date))
      .sort((a, b) => b.date - a.date);

    console.log(`✅ Found ${parsedDocs.length} patent documents for ${applicationNumber}`);
    return parsedDocs;
  } catch (error) {
    console.error(`❌ Error fetching patent docs for ${applicationNumber}:`, error.message);
    return [];
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
    let fileName;
    let mimeType = 'application/pdf';
    
    if (type === "Patent") {
      // Use proxy for patent documents to handle authentication
      const proxyUrl = `https://lawmatics-backend.onrender.com/api/patent/download?url=${encodeURIComponent(latestDoc.link)}`;
      response = await axios.get(proxyUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });
      fileName = `${applicationNumber}-${latestDoc.description.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
      mimeType = 'application/pdf';
    } else {
      // Trademark documents - handle both XML and PDF endpoints
      response = await axios.get(latestDoc.link, { 
        responseType: 'arraybuffer',
        timeout: 30000 
      });
      
      // Detect file type based on URL pattern and content
      if (latestDoc.link.includes('/webcontent')) {
        // This is a PDF document (like your example URL)
        console.log('📄 PDF trademark document detected');
        fileName = `${applicationNumber}-${latestDoc.description.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
        mimeType = 'application/pdf';
      } else if (latestDoc.link.includes('.xml')) {
        // This is an XML document
        console.log('📄 XML trademark document detected');
        fileName = `${applicationNumber}-${latestDoc.description.replace(/[^a-zA-Z0-9]/g, '_')}.xml`;
        mimeType = 'application/xml';
      } else {
        // Default to PDF for unknown types
        console.log('📄 Unknown trademark document type, defaulting to PDF');
        fileName = `${applicationNumber}-${latestDoc.description.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
        mimeType = 'application/pdf';
      }
    }
    
    const filePath = path.join(tmpDir, fileName);
    fs.writeFileSync(filePath, response.data);

    console.log(`📤 Uploading to Google Drive: ${fileName} (${mimeType})`);
    const driveRes = await uploadToDrive(
      filePath,
      fileName,
      process.env.GDRIVE_FOLDER_ID,
      mimeType
    );

    console.log(`📂 Uploaded ${type} doc to Drive: ${driveRes.webViewLink}`);
    
    const updatedDoc = { 
      ...latestDoc, 
      driveLink: driveRes.webViewLink,
      fileType: mimeType.split('/')[1]
    };
    
    // Clean up local file
    fs.unlinkSync(filePath);
    
    return updatedDoc;
  } catch (err) {
    console.error(`❌ Drive upload failed (${type}):`, err.message);
    return latestDoc;
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
// 📝 Form Automation (Puppeteer) - Vercel Compatible
// ========================

// Special Puppeteer setup for Vercel
async function getBrowser() {
  // For Vercel deployment
  if (process.env.VERCEL) {
    const chromium = require('@sparticuz/chromium-min');
    const puppeteerCore = require('puppeteer-core');
    
    return await puppeteerCore.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
  } else {
    // For local development
    return await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
}

/**
 * Helper function to safely clear and type into a field
 */
async function safeClearAndType(page, selector, value, timeout = 5000) {
  try {
    await page.waitForSelector(selector, { timeout, visible: true });
    await page.click(selector);
    
    try {
      await page.click(selector, { clickCount: 3 });
      await page.keyboard.press('Backspace');
    } catch (error) {
      const isMac = await page.evaluate(() => navigator.platform.toLowerCase().includes('mac'));
      const modifierKey = isMac ? 'Meta' : 'Control';
      
      await page.keyboard.down(modifierKey);
      await page.keyboard.press('a');
      await page.keyboard.up(modifierKey);
      await page.keyboard.press('Backspace');
    }
    
    await new Promise(r => setTimeout(r, 300));
    
    const currentValue = await page.$eval(selector, el => el.value);
    if (currentValue) {
      await page.evaluate((sel) => {
        document.querySelector(sel).value = '';
      }, selector);
    }
    
    await page.type(selector, value, { delay: 50 });
    
    const finalValue = await page.$eval(selector, el => el.value);
    if (finalValue !== value) {
      console.warn(` Value mismatch for ${selector}. Expected: ${value}, Got: ${finalValue}`);
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
async function submitFormWithPuppeteer(matterId, applicationNumber, latestDoc, type, prospectData) {
  let browser;
  try {
    browser = await getBrowser();
    const page = await browser.newPage();

    console.log(` Opening Lawmatics form for ${type} #${applicationNumber}...`);
    await page.goto(FORM_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Step 1: Enter Matter ID
    await page.waitForSelector("#id", { visible: true, timeout: 10000 });
    await safeClearAndType(page, "#id", matterId);

    // Step 2: Click "Find Matter"
    await page.click('button[type="submit"]');
    console.log("⏳ Waiting for Lawmatics to fetch matter details...");
    await new Promise(r => setTimeout(r, 15000));

    // Step 3: Fill USPTO fields
    console.log(" Filling USPTO details...");
    
    const documentLink = latestDoc.driveLink || latestDoc.link || "";
    
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

    for (const field of fieldsToFill) {
      if (field.value) {
        console.log(`   Filling ${field.description}...`);
        await safeClearAndType(page, field.selector, field.value);
        await new Promise(r => setTimeout(r, 300));
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
    if (browser) {
      await browser.close();
    }
  }
}

// ========================
// 📧 Enhanced Email Functions
// ========================

/**
 * Send enhanced email notification for new document
 */
async function sendEmailNotification(applicationNumber, latestDoc, type) {
  const docUrl = latestDoc.driveLink || latestDoc.link || "N/A";
  
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_TO,
    subject: `📄 New ${latestDoc.description} for ${type} #${applicationNumber}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">📄 New USPTO Document Found</h2>
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0;">${type} Application: <strong>${applicationNumber}</strong></h3>
          <ul style="list-style: none; padding: 0;">
            <li>📅 <strong>Document Date:</strong> ${latestDoc.date.toISOString().split('T')[0]}</li>
            <li>📋 <strong>Document Type:</strong> ${latestDoc.description}</li>
            ${type === "Patent" ? `
              <li>🔢 <strong>Document Code:</strong> ${latestDoc.documentCode}</li>
              <li>📁 <strong>Category:</strong> ${latestDoc.category}</li>
            ` : ''}
            <li>🔗 <strong>Document Link:</strong> ${docUrl !== "N/A" ? `<a href="${docUrl}" style="color: #3498db;">View Document</a>` : "No Link Available"}</li>
            ${latestDoc.driveLink ? `<li>☁️ <strong>Storage:</strong> Google Drive</li>` : ''}
          </ul>
        </div>
        <p style="color: #7f8c8d; font-size: 14px; text-align: center;">
          This is an automated update from USPTO ${type} Monitoring System<br>
          Monitored via Vercel Deployment
        </p>
      </div>
    `,
  });

  console.log(`📩 Email sent for ${type} ${applicationNumber}`);
}

/**
 * Send comprehensive summary email
 */
async function sendSummaryEmail(updatedMatters, totalMatters, totalDocuments) {
  const date = new Date().toISOString().split('T')[0];
  const time = new Date().toLocaleTimeString();
  
  let mattersTable = '';
  if (updatedMatters.length > 0) {
    mattersTable = `
      <h3>🆕 Updated Matters (${updatedMatters.length}):</h3>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <thead>
          <tr style="background-color: #2c3e50; color: white;">
            <th style="padding: 12px; border: 1px solid #ddd;">#</th>
            <th style="padding: 12px; border: 1px solid #ddd;">Application Number</th>
            <th style="padding: 12px; border: 1px solid #ddd;">Type</th>
            <th style="padding: 12px; border: 1px solid #ddd;">Latest Date</th>
            <th style="padding: 12px; border: 1px solid #ddd;">Documents</th>
            <th style="padding: 12px; border: 1px solid #ddd;">Description</th>
          </tr>
        </thead>
        <tbody>
          ${updatedMatters.map((matter, index) => `
            <tr style="${index % 2 === 0 ? 'background-color: #f8f9fa;' : ''}">
              <td style="padding: 10px; border: 1px solid #ddd;">${index + 1}</td>
              <td style="padding: 10px; border: 1px solid #ddd;"><strong>${matter.applicationNumber}</strong></td>
              <td style="padding: 10px; border: 1px solid #ddd;">${matter.type}</td>
              <td style="padding: 10px; border: 1px solid #ddd; color: #27ae60;"><strong>${matter.latestDocDate}</strong></td>
              <td style="padding: 10px; border: 1px solid #ddd;">${matter.docCount}</td>
              <td style="padding: 10px; border: 1px solid #ddd;">${matter.description}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } else {
    mattersTable = `
      <div style="background-color: #e8f5e9; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #2e7d32;">✅ All Matters Up to Date</h3>
        <p>No new documents found for any matters since last check.</p>
      </div>
    `;
  }
  
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_TO,
    subject: `📊 USPTO Monitor Summary - ${date} ${time} (6-Hour Check)`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0;">
          <h1 style="margin: 0; font-size: 28px;">🔍 USPTO Monitoring Summary</h1>
          <p style="opacity: 0.9; margin: 5px 0 0 0;">${date} | ${time} | 6-Hour Check</p>
        </div>
        
        <div style="padding: 30px; background-color: white; border-radius: 0 0 10px 10px; box-shadow: 0 2px 20px rgba(0,0,0,0.1);">
          
          <!-- Stats Overview -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px;">
            <div style="background-color: #e3f2fd; padding: 20px; border-radius: 8px; text-align: center;">
              <h3 style="margin: 0 0 10px 0; color: #1976D2;">📋 Total Matters</h3>
              <p style="font-size: 32px; margin: 0; font-weight: bold; color: #1976D2;">${totalMatters}</p>
            </div>
            <div style="background-color: #e8f5e9; padding: 20px; border-radius: 8px; text-align: center;">
              <h3 style="margin: 0 0 10px 0; color: #2e7d32;">🆕 Updated</h3>
              <p style="font-size: 32px; margin: 0; font-weight: bold; color: #2e7d32;">${updatedMatters.length}</p>
            </div>
            <div style="background-color: #fff3e0; padding: 20px; border-radius: 8px; text-align: center;">
              <h3 style="margin: 0 0 10px 0; color: #f57c00;">📄 Documents</h3>
              <p style="font-size: 32px; margin: 0; font-weight: bold; color: #f57c00;">${totalDocuments}</p>
            </div>
          </div>
          
          ${mattersTable}
          
          <!-- Schedule Information -->
          <div style="margin-top: 40px; padding: 20px; background-color: #f9f9f9; border-radius: 8px; border-left: 4px solid #3498db;">
            <h3 style="margin-top: 0; color: #2c3e50;">⏰ Monitoring Schedule</h3>
            <ul style="color: #555;">
              <li><strong>6-Hour Checks:</strong> Running every 6 hours (0:00, 6:00, 12:00, 18:00 UTC)</li>
              <li><strong>Next Check:</strong> In 6 hours</li>
              <li><strong>Daily Report:</strong> Generated at 9:00 AM daily</li>
              <li><strong>Last Run:</strong> ${new Date().toLocaleString()}</li>
            </ul>
          </div>
          
          <p style="margin-top: 30px; color: #7f8c8d; font-size: 14px; text-align: center; border-top: 1px solid #eee; padding-top: 20px;">
            This is an automated email from USPTO Monitoring System deployed on Vercel<br>
            <a href="https://your-project.vercel.app" style="color: #3498db;">View Dashboard</a> | 
            <a href="mailto:${process.env.EMAIL_USER}" style="color: #3498db;">Contact Admin</a>
          </p>
        </div>
      </div>
    `
  });
  
  console.log(`📊 Summary email sent with ${updatedMatters.length} updated matters`);
}

// ========================
// 🚀 Main Processing Functions
// ========================

/**
 * Process a single document with all steps
 */
async function processSingleDocument(matter, document, type) {
  const { applicationNumber, lawmaticsID } = matter;
  
  console.log(`   📄 Processing document: ${document.description} (${document.date.toISOString().split('T')[0]})`);

  // Download and upload to Google Drive
  const processedDoc = await downloadAndUploadToDrive(applicationNumber, document, type);

  // Send email notification
  await sendEmailNotification(applicationNumber, processedDoc, type);

  // Update Lawmatics via API
  await updateLawmaticsProspect(lawmaticsID, applicationNumber, processedDoc, type);

  // Get prospect data and submit form via Puppeteer
  const prospectData = await getProspect(lawmaticsID);
  if (prospectData) {
    await submitFormWithPuppeteer(lawmaticsID, applicationNumber, processedDoc, type, prospectData);
  } else {
    console.log(`⚠️ Could not fetch prospect data for ${lawmaticsID}, skipping form submission`);
  }

  return { processed: true, docDate: processedDoc.date };
}

/**
 * Process a single matter
 */
async function processMatter(matter, lastProcessedState, todayDate) {
  const { applicationNumber, lawmaticsID, type } = matter;
  
  console.log(`\n🔹 Processing ${type} #${applicationNumber} (Lawmatics ID: ${lawmaticsID})...`);

  let allDocs = [];
  if (type === "Patent") {
    allDocs = await fetchAllPatentDocs(applicationNumber);
  } else if (type === "Trademark") {
    allDocs = await fetchAllTrademarkDocs(applicationNumber);
  } else {
    console.error(`❌ Unknown type: ${type} for application ${applicationNumber}`);
    return { 
      processed: false, 
      reason: 'unknown_type', 
      docCount: 0,
      applicationNumber,
      type,
      description: 'Unknown type'
    };
  }

  if (allDocs.length === 0) {
    console.log(`⏭️ Skipping ${type} #${applicationNumber} - no documents found`);
    return { 
      processed: false, 
      reason: 'no_documents', 
      docCount: 0,
      applicationNumber,
      type,
      description: 'No documents'
    };
  }

  // Filter for new documents only
  const lastProcessedDate = lastProcessedState[applicationNumber];
  const newDocs = allDocs.filter(doc => 
    isNewDocument(doc.date, lastProcessedDate, todayDate)
  );

  if (newDocs.length === 0) {
    console.log(`⏭️ Skipping ${type} #${applicationNumber} - no new documents found`);
    return { 
      processed: false, 
      reason: 'not_new', 
      docCount: 0,
      applicationNumber,
      type,
      description: 'No new documents',
      latestDocDate: allDocs[0].date.toISOString().split('T')[0]
    };
  }

  // Only process documents from the LATEST date
  const latestDate = newDocs[0].date.toISOString().split('T')[0];
  const latestDateDocs = newDocs.filter(doc => 
    doc.date.toISOString().split('T')[0] === latestDate
  );

  console.log(`🆕 Found ${latestDateDocs.length} document(s) for LATEST date ${latestDate}`);

  let totalProcessed = 0;
  
  // Process each document from the latest date
  for (let i = 0; i < latestDateDocs.length; i++) {
    const document = latestDateDocs[i];
    
    console.log(`\n   📋 Document ${i + 1}/${latestDateDocs.length} for ${latestDate}`);
    
    await processSingleDocument(matter, document, type);
    totalProcessed++;

    // Add delay between submissions for multi-document dates
    if (latestDateDocs.length > 1 && i < latestDateDocs.length - 1) {
      console.log(`⏳ Adding ${SUBMISSION_DELAY_MS/1000}s delay before next submission...`);
      await new Promise(r => setTimeout(r, SUBMISSION_DELAY_MS));
    }
  }

  // Update the last processed date
  lastProcessedState[applicationNumber] = latestDate;

  return { 
    processed: totalProcessed > 0, 
    docCount: totalProcessed, 
    applicationNumber,
    type,
    description: latestDateDocs[0]?.description || 'Unknown',
    latestDocDate: latestDate,
    multiDoc: latestDateDocs.length > 1
  };
}

/**
 * Main function to process all matters
 */
async function processAllMatters() {
  try {
    const matters = await loadMatterMap();
    const lastProcessedState = await loadLastProcessedState();
    const todayDate = getTodayDateKey();
    
    if (matters.length === 0) {
      console.log("❌ No matters found in map.json");
      return { success: false, error: 'No matters found' };
    }

    console.log(`\n🚀 Starting 6-Hour USPTO Monitoring Check`);
    console.log(`📋 Found ${matters.length} matters to process`);
    console.log(`📅 Today's date: ${todayDate}`);
    console.log(`⏰ Check time: ${new Date().toLocaleTimeString()}`);
    
    let updatedMatters = [];
    let totalDocumentsProcessed = 0;
    
    // Process each matter sequentially
    for (const matter of matters) {
      const result = await processMatter(matter, lastProcessedState, todayDate);
      
      if (result.processed) {
        updatedMatters.push(result);
        totalDocumentsProcessed += result.docCount;
      }
      
      // Add a small delay between processing matters
      await new Promise(r => setTimeout(r, 2000));
    }
    
    // Save the updated state
    await saveLastProcessedState(lastProcessedState);
    
    // Send summary email
    await sendSummaryEmail(updatedMatters, matters.length, totalDocumentsProcessed);
    
    console.log(`\n📊 6-HOUR CHECK SUMMARY:`);
    console.log(`   Total matters: ${matters.length}`);
    console.log(`   Matters with updates: ${updatedMatters.length}`);
    console.log(`   Total documents processed: ${totalDocumentsProcessed}`);
    console.log(`   Multi-document dates: ${updatedMatters.filter(m => m.multiDoc).length}`);
    
    return {
      success: true,
      totalMatters: matters.length,
      updatedMatters: updatedMatters.length,
      totalDocuments: totalDocumentsProcessed,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error("❌ Error in main process:", error.message);
    return { success: false, error: error.message };
  }
}

// ========================
// 📊 CSV REPORT FUNCTIONS
// ========================

/**
 * Generate CSV report with latest document dates for all matters
 */
async function generateLatestDatesCSV() {
  try {
    console.log('📊 Generating latest dates CSV report...');
    
    const matters = await loadMatterMap();
    const lastProcessedState = await loadLastProcessedState();
    
    if (matters.length === 0) {
      console.log('❌ No matters found in map.json');
      return null;
    }

    // CSV headers
    const csvHeaders = ['Lawmatics ID', 'Application Number', 'Type', 'Latest Document Date', 'Last Processed Date', 'Description', 'Status'];
    const csvRows = [csvHeaders];

    // Process each matter to get latest document info
    for (const matter of matters) {
      const { applicationNumber, lawmaticsID, type } = matter;
      
      console.log(`🔍 Checking ${type} #${applicationNumber} for CSV report...`);

      let latestDoc = null;
      if (type === "Patent") {
        const docs = await fetchAllPatentDocs(applicationNumber);
        latestDoc = docs.length > 0 ? docs[0] : null;
      } else if (type === "Trademark") {
        const docs = await fetchAllTrademarkDocs(applicationNumber);
        latestDoc = docs.length > 0 ? docs[0] : null;
      }

      const lastProcessedDate = lastProcessedState[applicationNumber] || 'Never';
      const latestDocDate = latestDoc ? latestDoc.date.toISOString().split('T')[0] : 'No documents';
      const description = latestDoc ? latestDoc.description : 'N/A';
      const status = lastProcessedDate === latestDocDate ? 'Up to date' : 'Update available';

      csvRows.push([
        lawmaticsID,
        applicationNumber,
        type,
        latestDocDate,
        lastProcessedDate,
        description,
        status
      ]);

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));
    }

    // Generate CSV content
    const csvContent = csvRows.map(row => 
      row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    // Create CSV file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `uspto-latest-dates-${timestamp}.csv`;
    const filePath = path.join(tmpDir, fileName);

    await fs.promises.writeFile(filePath, csvContent);
    console.log(`✅ CSV report generated: ${filePath}`);

    // Upload to Google Drive
    const csvFolderId = process.env.CSV_REPORTS_FOLDER_ID || process.env.GDRIVE_FOLDER_ID;
    console.log('📤 Uploading CSV report to Google Drive...');
    const driveRes = await uploadToDrive(
      filePath, 
      fileName, 
      csvFolderId,
      'text/csv'
    );
    
    // Clean up local file
    fs.unlinkSync(filePath);
    
    console.log(`📂 CSV report uploaded to Drive: ${driveRes.webViewLink}`);
    
    // Email the CSV report
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_TO,
      subject: `📊 USPTO Latest Dates Report - ${new Date().toISOString().split('T')[0]}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50;">📊 USPTO Latest Dates Report</h2>
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p>The latest document dates report has been generated for all monitored matters.</p>
            <ul style="list-style: none; padding: 0;">
              <li>📋 <strong>Total Matters:</strong> ${matters.length}</li>
              <li>📅 <strong>Report Date:</strong> ${new Date().toISOString().split('T')[0]}</li>
              <li>🔗 <strong>Drive Link:</strong> <a href="${driveRes.webViewLink}" style="color: #3498db;">View Report</a></li>
              <li>⏰ <strong>Generated:</strong> ${new Date().toLocaleTimeString()}</li>
            </ul>
          </div>
          <p style="color: #7f8c8d; font-size: 14px; text-align: center;">
            This report shows the latest document date found for each monitored matter.
          </p>
        </div>
      `,
    });

    console.log('📩 CSV report email sent successfully');

    return {
      filePath,
      driveLink: driveRes.webViewLink,
      matterCount: matters.length,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ Error generating CSV report:', error.message);
    return null;
  }
}

/**
 * Generate and email CSV report
 */
async function generateAndEmailCSVReport() {
  return await generateLatestDatesCSV();
}

// ========================
// 🚀 Run Job Function
// ========================

/**
 * Run the monitoring job
 */
const runJob = async () => {
  console.log('⏰ Running 6-hour monitoring job at', new Date().toISOString());
  const result = await processAllMatters();
  console.log('✅ 6-hour job completed at', new Date().toISOString());
  return result;
};

// ========================
// 📤 EXPORTS
// ========================

module.exports = {
  // Main processing functions
  processMatter,
  processAllMatters,
  runJob,
  
  // Email functions
  sendEmailNotification,
  sendSummaryEmail,
  
  // Report functions
  generateLatestDatesCSV,
  generateAndEmailCSVReport,
  
  // Core API functions
  fetchAllPatentDocs,
  fetchAllTrademarkDocs,
  downloadAndUploadToDrive,
  getProspect,
  updateLawmaticsProspect,
  submitFormWithPuppeteer,
  
  // Utility functions
  loadMatterMap,
  loadLastProcessedState,
  saveLastProcessedState,
  getTodayDateKey,
  isNewDocument
};
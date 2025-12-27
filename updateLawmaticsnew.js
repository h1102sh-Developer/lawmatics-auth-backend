require('dotenv').config();
const cron = require('node-cron');
const fs = require('fs');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { parseStringPromise } = require('xml2js');

// ========================
// 🔐 CONFIG
// ========================
const LAW_TOKEN = "Bearer RUdAHUFQ_ouYf_Boc_cmVwZeq6v-mQbMQ4zd-wBpSLw"; // Hardcoded working token

// Email setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Load application mapping
const mapData = JSON.parse(fs.readFileSync('map.json', 'utf-8'));

// ========================
// 🔧 Lawmatics Helpers
// ========================

// Fetch Prospect (to get name & email)
const getProspect = async (lawmaticsID) => {
    try {
      const { data } = await axios.get(
        `https://api.lawmatics.com/v1/prospects/${lawmaticsID}?fields=all`,
        { headers: { Authorization: LAW_TOKEN } }
      );
      return data.data.attributes; // 👈 return attributes directly
    } catch (err) {
      console.error(`❌ Failed to fetch prospect ${lawmaticsID}:`, err?.response?.data || err.message);
      return null;
    }
  };

// Update Prospect (PUT)
const updateLawmaticsProspect = async (lawmaticsID, applicationNumber, latestDoc, type) => {
    try {
      // Build proxy URL for patents
      const docUrl =
        type === "Patent" && latestDoc.link
          ? `${process.env.BASE_URL}/api/patent/download?url=${encodeURIComponent(latestDoc.link)}`
          : latestDoc.link || "N/A";
  
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
          { id: "31473", value: applicationNumber }, // Application Number
          { id: "549382", value: latestDoc.date.toISOString().split("T")[0] }, // Mailroom Date
          { id: "624707", value: latestDoc.description }, // Document Description
          { id: "633940", value: latestDoc.documentCode || "N/A" }, // Patent Doc Code
          { id: "624715", value: latestDoc.category || "N/A" }, // Category
          { id: "654950", value: docUrl }, // ✅ Proxy URL if Patent
        ],
      };
  
      await axios.put(
        `https://api.lawmatics.com/v1/prospects/${lawmaticsID}`,
        payload,
        { headers: { Authorization: LAW_TOKEN, "Content-Type": "application/json" } }
      );
  
      console.log(`✅ Prospect ${lawmaticsID} updated for ${type} #${applicationNumber}`);
    } catch (error) {
      console.error(`❌ Prospect PUT failed for ${applicationNumber}:`, error?.response?.data || error.message);
    }
  };


// Submit Form
// Submit Form
const submitLawmaticsForm = async (prospectData, applicationNumber, latestDoc, type) => {
    try {
      const payload = {
        first_name: prospectData?.first_name || "N/A",
        last_name: prospectData?.last_name || "N/A",
        email: prospectData?.email || "N/A",
        phone: prospectData?.phone || "N/A",
  
        custom_field_31473: applicationNumber,
        custom_field_549382: latestDoc.date.toISOString().split("T")[0],
        custom_field_624707: latestDoc.description,
        custom_field_633940: latestDoc.documentCode || "N/A",
        custom_field_624715: latestDoc.category || "N/A",
        custom_field_633939: type === "Patent" ? "Patent Document" : "Trademark Document",
        case_title: type === "Patent" ? "Patent Document" : "Trademark Document",
  
        general_field_1e50: type === "Patent"
          ? `${process.env.BASE_URL}/api/patent/download?url=${encodeURIComponent(latestDoc.link)}`
          : latestDoc.link || "N/A",
      };
  
      await axios.post(
        "https://api.lawmatics.com/v1/forms/d2ab9a6a-2800-41f3-a4ba-51feedbf02b3/submit",
        payload,
        { headers: { Authorization: LAW_TOKEN, "Content-Type": "application/json" } }
      );
  
      console.log(`📤 Form submitted for ${type} #${applicationNumber}`);
    } catch (err) {
      console.error(`❌ Form submission failed for ${applicationNumber}:`, err?.response?.data || err.message);
    }
  };
  
  
// ========================
// 📌 Trademark Handler
// ========================
const processTrademark = async (applicationNumber, lawmaticsID) => {
  try {
    const url = `https://tsdrapi.uspto.gov/ts/cd/casedocs/bundle.xml?sn=${applicationNumber}`;
    const { data } = await axios.get(url, {
      headers: { 'USPTO-API-KEY': '5WFZ8ApIfVK4ZZKevqIGFn0WtgLVmw4w' },
    });

    const result = await parseStringPromise(data);
    const docs = result?.DocumentList?.Document || [];

    if (docs.length === 0) {
      console.log(`ℹ️ No documents found for Trademark ${applicationNumber}`);
      return;
    }

    const parsedDocs = docs
      .map(doc => {
        const rawDate = doc.MailRoomDate?.[0] || doc.ScanDateTime?.[0] || '';
        const cleanedDate = rawDate.replace(/-\d{2}:\d{2}$/, '');
        const dateObj = new Date(cleanedDate);

        return {
          date: isNaN(dateObj) ? null : dateObj,
          description: doc.DocumentTypeDescriptionText?.[0],
          link: doc.UrlPathList?.[0]?.UrlPath?.[0] || 'N/A',
        };
      })
      .filter(doc => doc.date !== null)
      .sort((a, b) => b.date - a.date);

    const latestDoc = parsedDocs[0];

    // Email notification
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_TO,
      subject: `New ${latestDoc.description} for Trademark #${applicationNumber}`,
      html: `
        <h4>Latest Document for Trademark #${applicationNumber}</h4>
        <ul>
          <li><strong>Date:</strong> ${latestDoc.date.toISOString().split('T')[0]}</li>
          <li><strong>Type:</strong> ${latestDoc.description}</li>
          <li><strong>Link:</strong> ${latestDoc.link !== 'N/A' ? `<a href="${latestDoc.link}">View Document</a>` : 'No Link Available'}</li>
        </ul>
        <p>This is an automated update from USPTO TSDR API.</p>
      `,
    });

    console.log(`📩 Email sent for Trademark ${applicationNumber}`);

    // Push to Lawmatics (Prospect PUT)
    await updateLawmaticsProspect(lawmaticsID, applicationNumber, latestDoc, "Trademark");

    // Push to Lawmatics Form (with Name + Email)
    const prospectData = await getProspect(lawmaticsID);
    if (prospectData) {
      await submitLawmaticsForm(prospectData, applicationNumber, latestDoc, "Trademark");
    }

  } catch (err) {
    console.error(`❌ Trademark processing error for ${applicationNumber}:`, err?.response?.data || err.message);
  }
};

// ========================
// 📌 Patent Handler
// ========================
const processPatent = async (applicationNumber, lawmaticsID) => {
  try {
    const url = `https://api.uspto.gov/api/v1/patent/applications/${encodeURIComponent(applicationNumber)}/documents`;
    const { data } = await axios.get(url, {
      headers: {
        accept: 'application/json',
        'X-API-KEY': process.env.USPTO_API_KEY || 'wbrvfnkztibwvbguoheyakqjlhgagv'
      },
    });

    const documentBag = data?.documentBag || [];
    if (documentBag.length === 0) {
      console.log(`ℹ️ No documents found for Patent ${applicationNumber}`);
      return;
    }

    const sortedDocs = documentBag
      .map(doc => ({
        date: new Date(doc.officialDate),
        description: doc.documentCodeDescriptionText,
        documentCode: doc.documentCode,
        category: doc.directionCategory,
        link: doc.downloadOptionBag?.[0]?.downloadUrl || null,
      }))
      .filter(doc => !isNaN(doc.date))
      .sort((a, b) => b.date - a.date);

    const latestDoc = sortedDocs[0];
    const proxyLink = latestDoc.link
  ? `${process.env.BASE_URL}/api/patent/download?url=${encodeURIComponent(latestDoc.link)}`
  : "N/A";

    // Email notification
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_TO,
      subject: `New ${latestDoc.description} for Patent #${applicationNumber}`,
      html: `
        <h4>Latest Document for Patent #${applicationNumber}</h4>
        <ul>
          <li><strong>Date:</strong> ${latestDoc.date.toISOString().split('T')[0]}</li>
          <li><strong>Type:</strong> ${latestDoc.description}</li>
          <li><strong>Code:</strong> ${latestDoc.documentCode}</li>
          <li><strong>Category:</strong> ${latestDoc.category}</li>
          <li><strong>Link:</strong> ${proxyLink !== "N/A" ? `<a href="${proxyLink}">View Document</a>` : "No Link Available"}</li>
        </ul>
        <p>This is an automated update from USPTO Patent API.</p>
      `,
    });

    console.log(`📩 Email sent for Patent ${applicationNumber}`);

    // Push to Lawmatics (Prospect PUT)
    await updateLawmaticsProspect(lawmaticsID, applicationNumber, latestDoc, "Patent");

    // Push to Lawmatics Form (with Name + Email)
    const prospectData = await getProspect(lawmaticsID);
    if (prospectData) {
      await submitLawmaticsForm(prospectData, applicationNumber, latestDoc, "Patent");
    }

  } catch (err) {
    console.error(`❌ Patent processing error for ${applicationNumber}:`, err?.response?.data || err.message);
  }
};

// ========================
// 🚀 Main Job Runner
// ========================
const runJob = async () => {
  console.log('⏰ Running scheduled job...');

  for (const { applicationNumber, lawmaticsID, type } of mapData) {
    if (type === 'Trademark') {
      await processTrademark(applicationNumber, lawmaticsID);
    } else if (type === 'Patent') {
      await processPatent(applicationNumber, lawmaticsID);
    } else {
      console.warn(`⚠️ Unknown type for ${applicationNumber}`);
    }
  }
};

// Run every 5 minutes
cron.schedule('*/5 * * * *', runJob);

// Run immediately on launch
runJob();

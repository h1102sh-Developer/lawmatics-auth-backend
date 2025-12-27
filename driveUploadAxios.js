// driveUploadAxios.js
require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const ACCESS_TOKEN = process.env.GDRIVE_ACCESS_TOKEN; // store in .env
const FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

async function uploadToDrive(filePath, fileName) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const form = new FormData();
  form.append(
    'metadata',
    JSON.stringify({ name: fileName, parents: [FOLDER_ID] }),
    { contentType: 'application/json' }
  );
  form.append('file', fs.createReadStream(filePath));

  const res = await axios.post(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    form,
    {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, ...form.getHeaders() },
    }
  );

  return res.data;
}

module.exports = { uploadToDrive };

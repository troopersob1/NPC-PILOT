/*
 * NPC.co — Google Apps Script Backend
 *
 * SETUP:
 * 1. Create a new Google Sheet (this will be your submissions tracker)
 * 2. Go to Extensions → Apps Script
 * 3. Delete the default code and paste this entire file
 * 4. Click Deploy → New Deployment
 * 5. Type: Web app
 * 6. Execute as: Me
 * 7. Who has access: Anyone
 * 8. Click Deploy — copy the Web App URL
 * 9. Paste that URL into the "Apps Script URL" field in the SEEDER Brand Portal
 */

var FOLDER_NAME = 'NPC Submissions';

function doPost(e) {
  try {
    // Handle form POST (e.parameter.data) or raw body (e.postData.contents)
    var raw = (e.parameter && e.parameter.data) ? e.parameter.data : e.postData.contents;
    var data = JSON.parse(raw);

    // Route: save campaign
    if (data._action === 'saveCampaign') {
      return saveCampaign(data);
    }
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Get or create Submissions sheet
    var sheet = ss.getSheetByName('Submissions');
    if (!sheet) {
      sheet = ss.insertSheet('Submissions');
      sheet.appendRow([
        'Timestamp', 'Campaign', 'Brand', 'NPC Name', 'IC Number',
        'Phone', 'Bank', 'Account Number', 'Email',
        'Tasks Done', 'Total Tasks', 'Screenshot Links', 'Status'
      ]);
      sheet.getRange(1, 1, 1, 13).setFontWeight('bold').setBackground('#1B2654').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }

    // Create Drive folder structure: NPC Submissions / BrandName - CampaignTitle /
    var campaignFolder = getOrCreateFolder(data.brand, data.campaign);

    // Save screenshots to Drive — organized into subfolders by task type
    var screenshotLinks = [];
    if (data.screenshots && data.screenshots.length > 0) {
      var subFolderCache = {};
      for (var i = 0; i < data.screenshots.length; i++) {
        var s = data.screenshots[i];
        try {
          // Get or create subfolder (e.g. "Instagram - Like", "Facebook - Comment", "Follow")
          var subName = s.folder || 'General';
          if (!subFolderCache[subName]) {
            var subs = campaignFolder.getFoldersByName(subName);
            subFolderCache[subName] = subs.hasNext() ? subs.next() : campaignFolder.createFolder(subName);
          }
          var targetFolder = subFolderCache[subName];

          var base64Data = s.data.split(',').length > 1 ? s.data.split(',')[1] : s.data;
          var fileName = (data.name || 'npc') + '_' + subName.replace(/\s/g,'_') + '_' + (i+1) + '.jpg';
          var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), s.type || 'image/jpeg', fileName);
          var file = targetFolder.createFile(blob);
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          screenshotLinks.push(file.getUrl());
        } catch (imgErr) {
          screenshotLinks.push('upload_error');
        }
      }
    }

    // Append submission row
    sheet.appendRow([
      new Date(),
      data.campaign || '',
      data.brand || '',
      data.name || '',
      data.ic || '',
      data.phone || '',
      data.bank || '',
      data.account || '',
      data.email || '',
      data.doneTasks || 0,
      data.totalTasks || 0,
      screenshotLinks.join('\n'),
      'Pending Review'
    ]);

    // Update Summary sheet
    updateSummary(ss, data.brand, data.campaign);

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: 'Submission received',
      screenshots: screenshotLinks.length
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var action = (e.parameter && e.parameter.action) || 'submissions';

    // Retrieve campaign data by ID
    if (action === 'getCampaign') {
      return getCampaign(ss, e.parameter.id || '');
    }

    if (action === 'summary') {
      return getSummary(ss, e.parameter.campaign || '');
    }

    // Default: return submissions
    var sheet = ss.getSheetByName('Submissions');
    if (!sheet || sheet.getLastRow() < 2) {
      return jsonOut({rows: [], total: 0});
    }

    var data = sheet.getDataRange().getValues();
    var campaign = (e.parameter && e.parameter.campaign) || '';
    var rows = [];

    for (var i = 1; i < data.length; i++) {
      if (!campaign || data[i][1] === campaign) {
        rows.push({
          timestamp: data[i][0] ? Utilities.formatDate(new Date(data[i][0]), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : '',
          campaign: data[i][1],
          brand: data[i][2],
          name: data[i][3],
          ic: data[i][4],
          phone: data[i][5],
          bank: data[i][6],
          account: data[i][7],
          email: data[i][8],
          done: data[i][9],
          total: data[i][10],
          screenshots: data[i][11],
          status: data[i][12]
        });
      }
    }

    return jsonOut({rows: rows, total: rows.length});

  } catch (err) {
    return jsonOut({error: err.toString()});
  }
}

function getSummary(ss, campaign) {
  var sheet = ss.getSheetByName('Submissions');
  if (!sheet || sheet.getLastRow() < 2) {
    return jsonOut({total: 0, completed: 0, pending: 0, screenshots: 0});
  }

  var data = sheet.getDataRange().getValues();
  var total = 0, completed = 0, pending = 0, totalScreenshots = 0;

  for (var i = 1; i < data.length; i++) {
    if (!campaign || data[i][1] === campaign) {
      total++;
      if (data[i][9] >= data[i][10] && data[i][10] > 0) completed++;
      else pending++;
      var links = String(data[i][11] || '');
      if (links) totalScreenshots += links.split('\n').filter(function(l){return l.trim();}).length;
    }
  }

  return jsonOut({
    total: total,
    completed: completed,
    pending: pending,
    screenshots: totalScreenshots
  });
}

function updateSummary(ss, brand, campaign) {
  var sumSheet = ss.getSheetByName('Summary');
  if (!sumSheet) {
    sumSheet = ss.insertSheet('Summary');
    sumSheet.appendRow(['Campaign', 'Brand', 'Total NPCs', 'Completed', 'Pending', 'Last Submission']);
    sumSheet.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#1B2654').setFontColor('#ffffff');
    sumSheet.setFrozenRows(1);
  }

  var subSheet = ss.getSheetByName('Submissions');
  if (!subSheet) return;
  var data = subSheet.getDataRange().getValues();

  var total = 0, completed = 0, lastTime = '';
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === campaign) {
      total++;
      if (data[i][9] >= data[i][10] && data[i][10] > 0) completed++;
      lastTime = data[i][0];
    }
  }

  // Find or create row
  var sumData = sumSheet.getDataRange().getValues();
  var found = -1;
  for (var j = 1; j < sumData.length; j++) {
    if (sumData[j][0] === campaign) { found = j + 1; break; }
  }

  var row = [campaign, brand, total, completed, total - completed, lastTime];
  if (found > 0) {
    sumSheet.getRange(found, 1, 1, 6).setValues([row]);
  } else {
    sumSheet.appendRow(row);
  }
}

function saveCampaign(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Campaigns');
  if (!sheet) {
    sheet = ss.insertSheet('Campaigns');
    sheet.appendRow(['ID', 'Created', 'Brand', 'Title', 'Payload']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold').setBackground('#1B2654').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }

  // Use client-provided ID or generate one
  var id = data.clientId || Utilities.getUuid().substring(0, 8);

  // Remove internal fields before storing
  var payload = JSON.parse(JSON.stringify(data));
  delete payload._action;

  sheet.appendRow([id, new Date(), payload.brand || '', payload.title || '', JSON.stringify(payload)]);

  return jsonOut({ success: true, id: id });
}

function getCampaign(ss, id) {
  if (!id) return jsonOut({ error: 'No campaign ID provided' });
  var sheet = ss.getSheetByName('Campaigns');
  if (!sheet) return jsonOut({ error: 'No campaigns found' });

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      try {
        var payload = JSON.parse(data[i][4]);
        return jsonOut({ success: true, campaign: payload });
      } catch (e) {
        return jsonOut({ error: 'Failed to parse campaign data' });
      }
    }
  }
  return jsonOut({ error: 'Campaign not found' });
}

function getOrCreateFolder(brand, campaign) {
  var root = DriveApp.getRootFolder();
  var topFolders = root.getFoldersByName(FOLDER_NAME);
  var topFolder = topFolders.hasNext() ? topFolders.next() : root.createFolder(FOLDER_NAME);

  var subName = (brand || 'Unknown') + ' - ' + (campaign || 'Campaign');
  var subs = topFolder.getFoldersByName(subName);
  return subs.hasNext() ? subs.next() : topFolder.createFolder(subName);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

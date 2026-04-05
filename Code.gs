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
    var raw = (e.parameter && e.parameter.data) ? e.parameter.data : e.postData.contents;
    var data = JSON.parse(raw);

    // Route: save campaign
    if (data._action === 'saveCampaign') {
      return saveCampaign(data);
    }

    // Route: approve/reject submission
    if (data._action === 'updateStatus') {
      return updateSubmissionStatus(data);
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // ── Per-campaign sheet with per-task columns ──
    var campaignName = data.campaign || 'Unknown Campaign';
    var sheetName = campaignName.substring(0, 100); // Sheet name max length
    var sheet = ss.getSheetByName(sheetName);

    // Build task columns from the screenshots data
    // Each screenshot has a .folder field like "Instagram - Like", "Facebook - Comment", "Follow"
    var taskColumns = [];
    var taskRates = {};
    if (data.taskMap) {
      // New format: taskMap sent from npc.html with task keys, labels, and rates
      for (var k = 0; k < data.taskMap.length; k++) {
        var tm = data.taskMap[k];
        taskColumns.push(tm.label);
        taskRates[tm.uid] = tm.rate || 0;
      }
    }

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      // Build header: fixed columns + dynamic task columns + pay + status
      var headers = ['Timestamp', 'NPC Name', 'IC Number', 'Phone', 'Bank', 'BNM Code', 'Account Number', 'Email'];
      for (var h = 0; h < taskColumns.length; h++) {
        headers.push('[' + formatRate(taskRates[data.taskMap[h].uid]) + '] ' + taskColumns[h]);
      }
      headers.push('Pay Amount', 'Status');
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1B2654').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      // Freeze first 2 columns (Timestamp, Name) for easy scrolling
      sheet.setFrozenColumns(2);
    }

    // Create Drive folder structure
    var campaignFolder = getOrCreateFolder(data.brand, campaignName);

    // Process screenshots — map each to its task column
    var taskScreenshots = {}; // uid → drive link
    if (data.screenshots && data.screenshots.length > 0) {
      var subFolderCache = {};
      for (var i = 0; i < data.screenshots.length; i++) {
        var s = data.screenshots[i];
        try {
          var subName = s.folder || 'General';
          if (!subFolderCache[subName]) {
            var subs = campaignFolder.getFoldersByName(subName);
            subFolderCache[subName] = subs.hasNext() ? subs.next() : campaignFolder.createFolder(subName);
          }
          var targetFolder = subFolderCache[subName];

          var base64Data = s.data.split(',').length > 1 ? s.data.split(',')[1] : s.data;
          var fileName = (data.name || 'npc') + '_' + subName.replace(/\s/g, '_') + '_' + (i + 1) + '.jpg';
          var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), s.type || 'image/jpeg', fileName);
          var file = targetFolder.createFile(blob);
          file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

          // Map to task uid
          if (s.uid) {
            taskScreenshots[s.uid] = file.getUrl();
          }
        } catch (imgErr) {
          if (s.uid) taskScreenshots[s.uid] = 'upload_error';
        }
      }
    }

    // Calculate pay amount based on completed tasks
    var payAmount = 0;
    if (data.taskMap) {
      for (var t = 0; t < data.taskMap.length; t++) {
        var taskUid = data.taskMap[t].uid;
        if (taskScreenshots[taskUid] && taskScreenshots[taskUid] !== 'upload_error') {
          payAmount += parseFloat(data.taskMap[t].rate) || 0;
        }
      }
    }

    // Extract BNM code from bank string (e.g. "27 - Maybank" → "27")
    var bankStr = data.bank || '';
    var bnmCode = '';
    var bankMatch = bankStr.match(/^(\d+)\s*-/);
    if (bankMatch) bnmCode = bankMatch[1];

    // Build row: fixed columns + task screenshot links + pay + status
    var row = [
      new Date(),
      data.name || '',
      data.ic || '',
      data.phone || '',
      bankStr,
      bnmCode,
      data.account || '',
      data.email || ''
    ];

    // Add per-task screenshot columns (empty string = task not done)
    if (data.taskMap) {
      for (var c = 0; c < data.taskMap.length; c++) {
        var link = taskScreenshots[data.taskMap[c].uid] || '';
        row.push(link);
      }
    }

    row.push(payAmount, 'Pending Review');
    sheet.appendRow(row);

    // Also append to master Submissions sheet (backward compat)
    appendToMasterSheet(ss, data, taskScreenshots, payAmount);

    // Update Summary
    updateSummary(ss, data.brand, campaignName);

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      message: 'Submission received',
      payAmount: payAmount,
      screenshots: Object.keys(taskScreenshots).length
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// Master sheet for backward compatibility and cross-campaign views
function appendToMasterSheet(ss, data, taskScreenshots, payAmount) {
  var sheet = ss.getSheetByName('Submissions');
  if (!sheet) {
    sheet = ss.insertSheet('Submissions');
    sheet.appendRow([
      'Timestamp', 'Campaign', 'Brand', 'NPC Name', 'IC Number',
      'Phone', 'Bank', 'BNM Code', 'Account Number', 'Email',
      'Tasks Done', 'Total Tasks', 'Pay Amount', 'Screenshot Links', 'Status'
    ]);
    sheet.getRange(1, 1, 1, 15).setFontWeight('bold').setBackground('#1B2654').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }

  var allLinks = [];
  for (var uid in taskScreenshots) {
    if (taskScreenshots[uid] && taskScreenshots[uid] !== 'upload_error') {
      allLinks.push(taskScreenshots[uid]);
    }
  }

  sheet.appendRow([
    new Date(),
    data.campaign || '',
    data.brand || '',
    data.name || '',
    data.ic || '',
    data.phone || '',
    data.bank || '',
    extractBnmCode(data.bank || ''),
    data.account || '',
    data.email || '',
    data.doneTasks || 0,
    data.totalTasks || 0,
    payAmount,
    allLinks.join('\n'),
    'Pending Review'
  ]);
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var action = (e.parameter && e.parameter.action) || 'submissions';

    if (action === 'getCampaign') {
      return getCampaign(ss, e.parameter.id || '');
    }

    if (action === 'summary') {
      return getSummary(ss, e.parameter.campaign || '');
    }

    // Campaign submissions — returns per-task data from campaign-specific sheet
    if (action === 'campaignSubmissions') {
      return getCampaignSubmissions(ss, e.parameter.campaign || '');
    }

    // Payment file data — returns IBG-ready data for a campaign
    if (action === 'paymentData') {
      return getPaymentData(ss, e.parameter.campaign || '');
    }

    // List all campaigns
    if (action === 'listCampaigns') {
      return listCampaigns(ss);
    }

    // Default: return submissions from master sheet
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
          bnmCode: data[i][7],
          account: data[i][8],
          email: data[i][9],
          done: data[i][10],
          total: data[i][11],
          payAmount: data[i][12],
          screenshots: data[i][13],
          status: data[i][14]
        });
      }
    }

    return jsonOut({rows: rows, total: rows.length});

  } catch (err) {
    return jsonOut({error: err.toString()});
  }
}

// ── Campaign-specific submissions with per-task breakdown ──
function getCampaignSubmissions(ss, campaignName) {
  if (!campaignName) return jsonOut({error: 'No campaign name provided'});
  var sheet = ss.getSheetByName(campaignName);
  if (!sheet || sheet.getLastRow() < 2) return jsonOut({rows: [], headers: [], total: 0});

  var allData = sheet.getDataRange().getValues();
  var headers = allData[0];
  var rows = [];

  for (var i = 1; i < allData.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = allData[i][j] || '';
      // Format timestamps
      if (j === 0 && allData[i][j]) {
        row[headers[j]] = Utilities.formatDate(new Date(allData[i][j]), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
      }
    }
    rows.push(row);
  }

  return jsonOut({headers: headers, rows: rows, total: rows.length});
}

// ── Payment file data (IBG format) ──
function getPaymentData(ss, campaignName) {
  if (!campaignName) return jsonOut({error: 'No campaign name provided'});
  var sheet = ss.getSheetByName(campaignName);
  if (!sheet || sheet.getLastRow() < 2) return jsonOut({rows: [], total: 0});

  var allData = sheet.getDataRange().getValues();
  var headers = allData[0];

  // Find column indices
  var colIdx = {};
  for (var h = 0; h < headers.length; h++) {
    var hdr = String(headers[h]);
    if (hdr === 'NPC Name') colIdx.name = h;
    else if (hdr === 'IC Number') colIdx.ic = h;
    else if (hdr === 'BNM Code') colIdx.bnm = h;
    else if (hdr === 'Account Number') colIdx.account = h;
    else if (hdr === 'Email') colIdx.email = h;
    else if (hdr === 'Pay Amount') colIdx.pay = h;
    else if (hdr === 'Status') colIdx.status = h;
    else if (hdr === 'Phone') colIdx.phone = h;
  }

  var rows = [];
  var refCounter = 1;

  for (var i = 1; i < allData.length; i++) {
    var status = String(allData[i][colIdx.status] || '');
    // Only include approved submissions
    if (status !== 'Approved') continue;

    var payAmt = parseFloat(allData[i][colIdx.pay]) || 0;
    if (payAmt <= 0) continue;

    var refNum = 'NPC' + String(refCounter).padStart(3, '0');
    refCounter++;

    rows.push({
      beneficiaryName: String(allData[i][colIdx.name] || '').toUpperCase(),
      beneficiaryId: String(allData[i][colIdx.ic] || ''),
      bnmCode: String(allData[i][colIdx.bnm] || ''),
      accountNumber: String(allData[i][colIdx.account] || '').replace(/[\s\-]/g, ''),
      paymentAmount: payAmt.toFixed(2),
      referenceNumber: refNum,
      email: String(allData[i][colIdx.email] || ''),
      paymentRefNumber: refNum,
      paymentDescription: campaignName,
      paymentDetailNumber: refNum,
      paymentDetailDate: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy'),
      paymentDetailDesc: campaignName,
      paymentDetailAmount: payAmt.toFixed(2)
    });
  }

  return jsonOut({rows: rows, total: rows.length, campaign: campaignName});
}

// ── List all campaigns from Campaigns sheet ──
function listCampaigns(ss) {
  var sheet = ss.getSheetByName('Campaigns');
  if (!sheet || sheet.getLastRow() < 2) return jsonOut({campaigns: []});

  var data = sheet.getDataRange().getValues();
  var campaigns = [];
  for (var i = 1; i < data.length; i++) {
    campaigns.push({
      id: data[i][0],
      created: data[i][1] ? Utilities.formatDate(new Date(data[i][1]), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : '',
      brand: data[i][2],
      title: data[i][3]
    });
  }
  return jsonOut({campaigns: campaigns});
}

// ── Update submission status (approve/reject) ──
function updateSubmissionStatus(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var campaign = data.campaign || '';
  var npcName = data.npcName || '';
  var ic = data.ic || '';
  var newStatus = data.status || ''; // 'Approved' or 'Rejected'

  if (!campaign || !newStatus) return jsonOut({error: 'Missing campaign or status'});

  // Update in campaign-specific sheet
  var sheet = ss.getSheetByName(campaign);
  if (sheet && sheet.getLastRow() >= 2) {
    var allData = sheet.getDataRange().getValues();
    var headers = allData[0];
    var statusCol = -1, nameCol = -1, icCol = -1;
    for (var h = 0; h < headers.length; h++) {
      if (headers[h] === 'Status') statusCol = h;
      if (headers[h] === 'NPC Name') nameCol = h;
      if (headers[h] === 'IC Number') icCol = h;
    }

    if (statusCol >= 0) {
      for (var i = 1; i < allData.length; i++) {
        var matchName = nameCol >= 0 && String(allData[i][nameCol]) === npcName;
        var matchIc = icCol >= 0 && String(allData[i][icCol]) === ic;
        if (matchName || matchIc) {
          sheet.getRange(i + 1, statusCol + 1).setValue(newStatus);
          break;
        }
      }
    }
  }

  // Also update master Submissions sheet
  var masterSheet = ss.getSheetByName('Submissions');
  if (masterSheet && masterSheet.getLastRow() >= 2) {
    var masterData = masterSheet.getDataRange().getValues();
    for (var j = 1; j < masterData.length; j++) {
      if (String(masterData[j][1]) === campaign && (String(masterData[j][3]) === npcName || String(masterData[j][4]) === ic)) {
        masterSheet.getRange(j + 1, 15).setValue(newStatus); // Status is column 15
        break;
      }
    }
  }

  return jsonOut({success: true, status: newStatus});
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
      if (data[i][10] >= data[i][11] && data[i][11] > 0) completed++;
      else pending++;
      var links = String(data[i][13] || '');
      if (links) totalScreenshots += links.split('\n').filter(function(l) { return l.trim(); }).length;
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
      if (data[i][10] >= data[i][11] && data[i][11] > 0) completed++;
      lastTime = data[i][0];
    }
  }

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

  var id = data.clientId || Utilities.getUuid().substring(0, 8);
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

function extractBnmCode(bankStr) {
  var match = String(bankStr).match(/^(\d+)\s*-/);
  return match ? match[1] : '';
}

function formatRate(val) {
  return 'RM ' + parseFloat(val || 0).toFixed(2);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

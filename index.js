"use strict";

const {
  BaseKonnector,
  requestFactory,
  saveBills,
  log,
  next,
  cozyClient
} = require("cozy-konnector-libs");
const moment = require("moment");
const pdf = require("html-pdf");
const bluebird = require("bluebird");
const path = require("path");
const requestBase = requestFactory({
  method: "GET",
  cheerio: true,
  jar: true,
  debug: false,
  headers: {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  },
  followAllRedirects: true
});

const baseUrl = "https://theoldreader.com";

module.exports = new BaseKonnector(start);

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
function start(fields) {
  // The BaseKonnector instance expects a Promise as return of the function
  return requestBase(baseUrl)
    .then($ => {
      log("debug", "Getting csrf param");
      return {
        name: $("meta[name=csrf-param]").attr("content"),
        token: $("meta[name=csrf-token]").attr("content")
      };
    })
    .then(csrf => {
      log("debug", "Login");
      const formData = {
        commit: "Sign In",
        "user[login]": fields.login,
        "user[password]": fields.password
      };
      formData[`${csrf.name}`] = csrf.token;

      return requestBase({
        url: `${baseUrl}/users/sign_in`,
        method: "POST",
        form: formData,
        simple: false
      });
    })
    .then($ => {
      const signInElement = $("a[href='/users/sign_in']");
      if (signInElement.length > 0) {
        log("error", "Signin failed");
        throw new Error("LOGIN_FAILED");
      }
      return requestBase({ url: `${baseUrl}/accounts/-/edit` });
    })
    .then($ => {
      log("debug", "Parsing receipts");

      return Array.from($(".payment-info > table > tbody > tr")).map(entry => {
        const currentLine = $(entry);
        const entryProperties = currentLine.children();
        const billDate = moment.utc(
          $(entryProperties[0]).text(),
          "MMMM DD, YYYY"
        );
        // log("debug", currentLine);
        const billUrl = parseBillUrl(entryProperties[2], $);
        const billId = getBillId(billUrl);
        return {
          amount: normalizeAmount($(entryProperties[1]).text()),
          fileurl: `${baseUrl}${billUrl}`,
          date: billDate.toDate(),
          type: "service",
          vendor: "The Old Reader",
          filename: getFileName(billDate, billId),
          id: billId
        };
      });
    })
    .mapSeries(getPdfStream)
    .then(bills => {
      log("debug", bills, "bills");

      return saveBillsHack(bills, fields.folderPath, {
        timeout: Date.now() + 60 * 1000,
        identifiers: "theoldreader" // bank operation identifier
      });
    });
}

function getPdfStream(bill) {
  log("debug", `getting invoice: ${bill.fileurl}`);

  return requestBase({ url: bill.fileurl })
    .then($ => {
      log("debug", `invoice downloaded`);
      $("img[alt=Logo]").attr("src", path.join("file://", __dirname, "assets/logo.png"));
      $("link[rel=stylesheet]").attr("href", path.join("file://", __dirname, "assets/style.css"));

      return bluebird.fromCallback(cb => {
        pdf.create($.html()).toStream(cb);
      });
    })
    .then(pdfStream => {
      bill.filestream = pdfStream;
      log("debug", `invoice ${bill.id} streamed!`);
      delete bill.fileurl;
      return bill;
    })
    .catch(err => log("error", err));
}

function parseBillUrl(tr, $) {
  return $(tr)
    .children("a")
    .attr("href");
}

function getBillId(billUrl) {
  const billIdParamName = "invoice_id";
  const startIndex =
    billUrl.indexOf(billIdParamName) + billIdParamName.length + 1;
  const endIndex = billUrl.indexOf("&", startIndex);
  return billUrl.substring(startIndex, endIndex === -1 ? undefined : endIndex);
}

function normalizeAmount(amount) {
  return parseFloat(amount.replace("$", "").trim());
}

function getFileName(entryDate, entryId) {
  return `${entryDate.format("YYYY_MM_DD")}_${entryId}_TheOldReader.pdf`;
}

// Waiting for https://github.com/cozy/cozy-konnector-libs/issues/90
function saveBillsHack(entries, fields, options = {}) {
  log("debug", "save bills");

  if (entries.length === 0) return Promise.resolve();

  if (typeof fields === "string") {
    fields = { folderPath: fields };
  }

  return bluebird.mapSeries(entries, entry => saveEntry(entry, fields))
  .catch(err => {
    log("error", err);
    throw err;
  });
}

function saveEntry(entry, fields) {
  return cozyClient.files.statByPath(fields.folderPath).then(folder => {
    const createFileOptions = {
      name: entry.filename,
      dirID: folder._id
    };
    return cozyClient.files.create(entry.filestream, createFileOptions);
  });
}

// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://d0d79b33fcc04b61a86b388cfbcb361b:f97e4a087c66499bae48d267122a04c5@sentry.cozycloud.cc/32'

import * as fs from "fs";
import * as moment from "moment";
import * as pdf from "pdfjs";
import * as connection from "cozy-konnector-connection/connection.js";

import {
  BaseKonnector,
  requestFactory,
  saveBills,
  log
} from "cozy-konnector-libs";

const requestBase: any = requestFactory({
  method: "GET",
  cheerio: true,
  jar: true,
  debug: false,
  headers: {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  },
  followAllRedirects: true
});

const baseUrl: string = "https://theoldreader.com";

module.exports = new BaseKonnector(start);

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
function start(fields: any): Promise<any> {
  // The BaseKonnector instance expects a Promise as return of the function
  return connection.init(baseUrl, "users/sign_in", "#new_user",
          { "user[login]": fields.login, "user[password]": fields.password },
          "cheerio",
          (statusCode, $) => statusCode === 200 && $("a[href='/users/sign_in']").length === 0)
    .then(() => requestBase({ url: `${baseUrl}/accounts/-/edit` }))
    .then(($: CheerioAPI) => {
      log("debug", "Parsing receipts");

      return Array.from($(".payment-info > table > tbody > tr")).map(entry => {
        const currentLine: Cheerio = $(entry);
        const entryProperties: Cheerio = currentLine.children();
        const billDate: moment.Moment = moment.utc(
          $(entryProperties[0]).text(),
          "MMMM DD, YYYY"
        );

        const billUrl: string = parseBillUrl(entryProperties[2], $);
        const billId: string = getBillId(billUrl);
        return {
          amount: normalizeAmount($(entryProperties[1]).text()),
          fileurl: `${baseUrl}${billUrl}`,
          date: billDate.toDate(),
          type: "service",
          vendor: "The Old Reader",
          filename: getFileName(billDate, billId),
          id: billId,
          currency: "USD"
        };
      });
    })
    .mapSeries(getPdfStream)
    .then((bills: Array<any>) => {
      return saveBills(bills, fields.folderPath, {
        timeout: Date.now() + 60 * 1000,
        identifiers: "theoldreader" // bank operation identifier
      });
    });
}

function getPdfStream(bill: any): Promise<any> {
  log("debug", `getting invoice: ${bill.fileurl}`);

  return requestBase({ url: bill.fileurl })
    .then(($: CheerioAPI) => {
      log("debug", `invoice downloaded`);

      const billData: CheerioElement[] = Array.from($(".container > .row > .col-md-12 > table > tbody > tr > td"));

      return generatePDF(
        bill.id,
        $(".container > .row > .col-md-12 > strong")[0].next.nodeValue.trim(),
        billData[0].firstChild.nodeValue.trim().replace(/\r?\n|\r/g, "").replace(/\s{2,}/g, " "),
        billData[1].firstChild.nodeValue.trim(),
        billData[2].firstChild.nodeValue.trim()
      );
    })
    .then((pdfStream: fs.ReadStream) => {
      bill.filestream = pdfStream;
      delete bill.fileurl;
      return bill;
    })
    .catch((err: Error) => log("PDF generation error", err));
}

function parseBillUrl(tr: CheerioElement, $: CheerioAPI): string {
  return $(tr)
    .children("a")
    .attr("href");
}

function getBillId(billUrl: string): string {
  const billIdParamName: string = "invoice_id";
  const startIndex: number =
    billUrl.indexOf(billIdParamName) + billIdParamName.length + 1;
  const endIndex: number = billUrl.indexOf("&", startIndex);
  return billUrl.substring(startIndex, endIndex === -1 ? undefined : endIndex);
}

function normalizeAmount(amount: string): number {
  return parseFloat(amount.replace("$", "").trim());
}

function getFileName(entryDate: moment.Moment, entryId: string): string {
  return `${entryDate.format("YYYY_MM_DD")}_${entryId}_TheOldReader.pdf`;
}

function generatePDF(invoidID: string, account: string, item: string, date: string, amount: string): fs.ReadStream {
  const helveticaFont: any = new pdf.Font(require("pdfjs/font/Helvetica.json"));
  const helveticaBoldFont: any = new pdf.Font(
    require("pdfjs/font/Helvetica-Bold.json")
  );

  const src: Buffer = fs.readFileSync("tor-logo.jpg");
  const logo: any = new pdf.Image(src);

  var doc: any = new pdf.Document({ font: helveticaFont });

  doc.cell({ paddingBottom: 0.5 * pdf.cm }).image(logo, { width: 150 });
  doc
    .cell({ paddingBottom: 0.5 * pdf.cm })
    .text()
    .add("Receipt", { font: helveticaBoldFont, fontSize: 14 })
    .br()
    .add("The Old Reader, Inc.")
    .br()
    .add("theoldreader.com", {
      underline: true,
      color: 0x569cd6,
      link: "https://theoldreader.com"
    })
    .br()
    .add(`Invoice ID: ${invoidID}`);

  doc
    .cell({ paddingBottom: 0.5 * pdf.cm })
    .text()
    .add("Account: ", { font: helveticaBoldFont })
    .add(account);

  var table: any = doc.table({
    widths: ["*", "*", "*"],
    borderWidth: 1,
    padding: 5
  });

  var trHead: any = table.header({
    font: helveticaBoldFont,
    borderBottomWidth: 1.5
  });
  trHead.cell("Item");
  trHead.cell("Date");
  trHead.cell("Amount");

  var tr: any = table.row();
  tr.cell(item);
  tr.cell(date, { textAlign: "right" });
  tr.cell(amount, { textAlign: "right" });

  doc
    .cell({ paddingTop: 0.5 * pdf.cm })
    .text("Thank you!", { font: helveticaBoldFont });

  doc.end();

  return doc;
}

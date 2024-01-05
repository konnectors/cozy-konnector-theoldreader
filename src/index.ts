import { BaseKonnector, log, requestFactory, saveBills, signin } from "cozy-konnector-libs";
import * as moment from "moment";
import * as pdf from "pdfjs";

const requestBase: any = requestFactory({
  method: "GET",
  cheerio: true,
  jar: true,
  //debug: true,
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
  return signin({
    url: `${baseUrl}/users/sign_in`,
    formSelector: "#new_user",
    formData: {
      "user[login]": fields.login,
      "user[password]": fields.password
    },
    parse: "cheerio",
    validate: (statusCode, $) =>
      statusCode === 200 && $("a[href='/users/sign_in']").length === 0,
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  })
    .then(() => requestBase({ url: `${baseUrl}/accounts/-/edit` }))
    .then(($: cheerio.CheerioAPI) => {
      log("info", "Parsing receipts");

      return Array.from($(".payment-info > table > tbody > tr")).map(entry => {
        const currentLine: cheerio.Cheerio = $(entry);
        const entryProperties: cheerio.Cheerio = currentLine.children();
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
        identifiers: "theoldreader", // bank operation identifier
        contentType: 'application/pdf'
      });
    });
}

function getPdfStream(bill: any): Promise<any> {
  log("info", `getting invoice: ${bill.fileurl}`);

  return requestBase({ url: bill.fileurl })
    .then(($: cheerio.CheerioAPI) => {
      log("info", `invoice downloaded`);

      const billData: cheerio.TagElement[] = <cheerio.TagElement[]> Array.from($(".container > .row > .col-md-12 > table > tbody > tr > td"));

      return generatePDF(
        bill.id,
        (<cheerio.TagElement>$(".container > .row > .col-md-12 > strong")[0].next)!.nodeValue.trim(),
        (<cheerio.TagElement>billData[0].firstChild).nodeValue.trim().replace(/\r?\n|\r/g, "").replace(/\s{2,}/g, " "),
        (<cheerio.TagElement>billData[1].firstChild).nodeValue.trim(),
        (<cheerio.TagElement>billData[2].firstChild).nodeValue.trim()
      );
    })
    .then((pdfStream) => {
      bill.filestream = pdfStream;
      delete bill.fileurl;
      return bill;
    })
    .catch((err: Error) => log("error", err, "PDF generation error"));
}

function parseBillUrl(tr: cheerio.Element, $: cheerio.CheerioAPI): string {
  return $(tr)
    .children("a")
    .attr("href")!;
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

function generatePDF(invoidID: string, account: string, item: string, date: string, amount: string): pdf.Document {
  const helveticaBoldFont: pdf.Font = require("pdfjs/font/Helvetica-Bold");

  // const src: Buffer = fs.readFileSync("tor-logo.jpg");
  // const logo: any = new pdf.Image(src);

  var doc: pdf.Document = new pdf.Document();

  // doc.cell({ paddingBottom: 0.5 * pdf.cm }).image(logo, { width: 150 });
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

  var table: pdf.Table = doc.table({
    widths: ["*", "*", "*"],
    borderWidth: 1,
    padding: 5
  });

  var trHead: pdf.Row = table.header({
    font: helveticaBoldFont
  });
  trHead.cell("Item");
  trHead.cell("Date");
  trHead.cell("Amount");

  var tr: pdf.Row = table.row();
  tr.cell(item);
  tr.cell(date, { textAlign: "right" });
  tr.cell(amount, { textAlign: "right" });

  doc
    .cell({ paddingTop: 0.5 * pdf.cm })
    .text("Thank you!", { font: helveticaBoldFont });

  doc.end();

  return doc;
}

import * as path from "path";
import { ReadStream } from "fs";
import * as moment from "moment";
import * as pdf from "html-pdf";
import * as bluebird from "bluebird";

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
  return requestBase(baseUrl)
    .then(($: CheerioAPI) => {
      log("debug", "Getting csrf param");
      return {
        name: $("meta[name=csrf-param]").attr("content"),
        token: $("meta[name=csrf-token]").attr("content")
      };
    })
    .then((csrf: any) => {
      log("debug", "Login");
      const formData: any = {
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
    .then(($: CheerioAPI) => {
      const signInElement: Cheerio = $("a[href='/users/sign_in']");
      if (signInElement.length > 0) {
        log("error", "Signin failed");
        throw new Error("LOGIN_FAILED");
      }
      return requestBase({ url: `${baseUrl}/accounts/-/edit` });
    })
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
          id: billId
        };
      });
    })
    .mapSeries(getPdfStream)
    .then((bills: Array<any>) => {
      log("debug", bills, "bills");

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
      $("img[alt=Logo]").attr(
        "src",
        path.join("file://", __dirname, "assets/logo.png")
      );
      $("link[rel=stylesheet]").attr(
        "href",
        path.join("file://", __dirname, "assets/style.css")
      );

      return bluebird.fromCallback(cb => {
        pdf.create($.html()).toStream(cb);
      });
    })
    .then((pdfStream: ReadStream) => {
      bill.filestream = pdfStream;
      log("debug", `invoice ${bill.id} streamed!`);
      delete bill.fileurl;
      return bill;
    })
    .catch((err: Error) => log("error", err));
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

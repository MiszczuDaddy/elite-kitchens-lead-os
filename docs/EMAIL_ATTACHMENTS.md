# Opening a customer's email attachments (22 Nov 2026)

On the **Emails** page, each file that came with an email has its own **View** button, so you do not have to open Gmail to read a customer's PDF or picture (or the rough estimate you sent them from Gmail).

## What you see
Under an email in a customer's conversation: **Attachments** and one button per file, such as **View Quote QU54797_261118_093117.pdf (84 KB)**.

* **PDFs and pictures** (PNG, JPG, GIF, WebP) open in a new tab. The tab is opened the moment you click and filled when the file arrives; if your browser blocks the new tab, the file is downloaded instead and a line says so.
* **Anything else** (Word, Excel, a zip, a web page...) is **downloaded**, never shown. A web page or SVG sent by a stranger must never run inside Elite OS, so only the types a browser shows safely are opened.
* While it is fetching the button says **Opening…**. If Gmail cannot give the file (the email was deleted, Google did not answer, the file is over 8 MB, Elite OS is not allowed to read the mailbox) a plain red line under the button says why and what to do; the file is still in Gmail.

## How it works (and what is NOT stored)
The chat keeps only each file's **name and size** (as before). The file itself stays in Gmail. When you click **View**, the browser calls **`getEmailAttachment`** (staff only) with the customer, the email's record in their chat and the file's number. The server:

1. checks the email's own record lists that file number, and that the record came from Gmail (it has a Gmail id): it can never be asked for an arbitrary Gmail message;
2. asks Gmail (the same **read-only** sign-in the email inbox uses: `gmail.readonly`, no new approval) for that message and finds the file by its number; the file found must have **exactly the name that was recorded**, or it is refused;
3. refuses a file over **8 MB** (it would not fit in the answer: open the email in Gmail);
4. returns the file to the browser, which shows it. **Nothing is written to Firestore or Storage**, nothing is sent, nothing in Gmail changes;
5. writes one line to the audit log: **who** and **which customer** (the last four digits of the number), the time. Never the file's name or contents.

"File number N" is defined once (`attachmentParts` in `lib/emailInbound.js`), used both when the list of names is kept and when a file is looked up, so they cannot drift apart.

## What it does not cover
* **Quote PDFs sent by Elite OS** are not attachments in the chat: the quote itself (and its PDF) is on the quote page ("Sent · quote" emails say so).
* Emails you sent from Gmail **with** files are found in the Sent folder like any other and their files can be viewed the same way (as in the screenshot that prompted this).
* Emails Elite OS sent itself (replies, follow-ups) carry no files.
* A file Gmail no longer has (the email was deleted from the mailbox) cannot be shown; Elite OS keeps no copy.

## Putting it live
1. `./scripts/deploy-quote-sending.sh emailattach`: ONE new function, `getEmailAttachment`. It needs the email inbox deployed and switched on (`emailin`), because it uses the same mailbox sign-in. It asks you to type `yes`, makes the new function reachable (it checks the signed-in staff account itself, like the other staff functions) and checks it refuses a request without sign-in.
2. `./scripts/deploy-quote-sending.sh live` (the screen: the View buttons).

Go back: `firebase functions:delete getEmailAttachment --region europe-west1 --project elite-kitchens-lead-os`. The buttons then say the file could not be fetched; nothing else is affected.

## Tests
`functions/test/email-attachment.test.js` (9, emulator): the file is fetched (by attachment id, and inline), nothing stored; the audit line holds no file name; strict input and "only a file the email lists"; the recorded name must match; size limits; the type is checked (a web page type becomes a plain download type); Google refusing or not answering; staff only and read-only; the mailbox reader's `attachment()` call; the one shared rule for "file number N". `test-ui/email-list.e2e.js` (11): in a real browser, a PDF and a picture open in their own tab with exactly Gmail's bytes, a web page sent as a file is only downloaded and never runs, a deleted email shows a plain message, and the buttons fit a 375px phone. `functions/test/scripts.test.js`: the deploy stage.

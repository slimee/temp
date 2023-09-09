const Imap = require('imap');
const {Decoder} = require('libqp');
const {parse} = require("csv-parse");
const { MongoClient, ServerApiVersion } = require('mongodb');
const fs = require("fs");

const path = `fichiers/${Date.now()}/`;
fs.mkdirSync(path, { recursive: true })
let count = 0;

async function run() {
    const client = new MongoClient(process.env.MONGO_URI, { serverApi: ServerApiVersion.v1 });
    await client.connect();
    const db = client.db("maison");
    try{
        await db.dropDatabase();
    }catch(err){
        console.error(err);
    }
    const collection = db.collection("govee");

    const imap = new Imap({
        user: process.env.MAIL,
        password: process.env.MAIL_PWD,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: {
            rejectUnauthorized: false
        },
        authTimeout: 3000
    }).once('error', err => console.log('imap', err));
    imap.connect(); await imapOnceReady(imap);
    const mailbox = await imapOpenbox(imap, 'INBOX');

    console.log(`Total messages in ${mailbox.name}: ${mailbox.messages.total}`);

    const onMessage = function (messageEventEmitter) {
        let mailDate;
        messageEventEmitter.on('body', function (stream) {
            stream.on('data', function (chunk) {
                mailDate = chunk.toString().split('\r\n')[0].split(',')[1].trim();
            });
        });
        messageEventEmitter.once('attributes', function (attrs) {
            const attachments = findAttachmentParts(attrs.struct);
            for (let i = 0, len = attachments.length; i < len; ++i) {
                const attachment = attachments[i];
                const pjFetch = imap.fetch(attrs.uid, { //do not use imap.seq.fetch here
                    bodies: [attachment.partID],
                    struct: true
                });
                pjFetch.on('message', (message) => {
                    message.on('body', async function (stream) {
                        const room =  attachment.params.name.split('_')[0];
                        let rowCount = 0;
                        let firstDatetime;
                        let lastDatetime;
                        stream
                            .pipe(new Decoder())
                            .pipe(parse({from_line: 2}))
                            .on("data", async (row) => {
                                const [rawTime, rawTemp, rawHydro] = row;
                                const [datetime, temp, hydro] = [new Date(rawTime), Number(rawTemp), Number(rawHydro)];
                                if(!firstDatetime) firstDatetime = datetime;
                                lastDatetime = datetime;
                                rowCount++;
                                count++;
                                await collection.insertOne({ room, datetime, temp, hydro })
                                    .catch(err => console.error(`Failed to update document: ${err}`));
                            })
                            .on('end', () => {
                                console.log(`${mailDate} - ${formatDatetime(firstDatetime)} => ${formatDatetime(lastDatetime)}, message ${attrs.uid}, ${room}, attachment ${i}, ${rowCount} rows, total: ${count}`);
                            });

                        stream
                            .pipe(new Decoder())
                            .pipe(fs.createWriteStream(`${path}/${attrs.uid}-${room}.csv`));
                    });
                });
            }
        });
    };
    imapFetch(imap, onMessage);
}
async function imapOnceReady(imap) {
    return new Promise((resolve, reject) => {
        imap.once('ready', () => resolve());
        imap.once('error', err => reject(err));
    })
}

async function imapOpenbox(imap, boxName) {
    return new Promise((resolve, reject) => {
        imap.openBox(boxName, true, (err, box) => {
            if (err) reject(err);
            resolve(box);
        });
    })
}

function imapFetch(imap, onMessage) {
    const fetchOptions = {
        bodies: ['HEADER.FIELDS (DATE)'],
        struct: true
    };
    const fetch = imap.seq.fetch('1:*', fetchOptions);
    fetch.once('error', function (err) {});
    fetch.once('end', function () { imap.end(); });
    fetch.on('message', onMessage);
}

function findAttachmentParts(struct, attachments) {
    attachments = attachments || [];
    for (let i = 0, len = struct.length; i < len; ++i) {
        if (Array.isArray(struct[i])) {
            findAttachmentParts(struct[i], attachments);
        } else {
            if (struct[i].disposition && ['INLINE', 'ATTACHMENT'].indexOf(toUpper(struct[i].disposition.type)) > -1) {
                attachments.push(struct[i]);
            }
        }
    }
    return attachments;
}

function toUpper(thing) {
    return thing && thing.toUpperCase ? thing.toUpperCase() : thing;
}

function formatDatetime(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

run().catch(console.error);

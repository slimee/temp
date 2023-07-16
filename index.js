const Imap = require('imap');
const {Decoder} = require('libqp');
const {parse} = require("csv-parse");
const { MongoClient, ServerApiVersion } = require('mongodb');
const fs = require("fs");

const path = `fichiers/${Date.now()}/`;
fs.mkdirSync(path, { recursive: true })

async function run() {
    const client = new MongoClient(process.env.MONGO_URI, { serverApi: ServerApiVersion.v1 });
    await client.connect();
    const collection = client.db("maison").collection("govee");
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
    await imapOpenbox(imap, 'INBOX');

    const onMessage = function (messageEventEmitter) {
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
                        stream
                            .pipe(new Decoder())
                            .pipe(parse({from_line: 2}))
                            .on("data", (row) => {
                                const [rawTime, temp, hydro] = row;
                                collection.insertOne({
                                    room,
                                    datetime: new Date(rawTime),
                                    temp: Number(temp),
                                    hydro: Number(hydro)
                                })
                                rowCount++;
                            })
                            .on('end', () => {
                                console.log(`message ${attrs.uid}, room ${room}, attachment ${i}, ${rowCount} rows`);
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
    const fetch = imap.seq.fetch('1:*', {
        bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'],
        struct: true
    });
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

run().catch(console.error);

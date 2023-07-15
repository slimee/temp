const Imap = require('imap');
const {Decoder} = require('libqp');
const {parse} = require("csv-parse");
const { MongoClient, ServerApiVersion } = require('mongodb');

const myMail = process.env.MAIL;
const myPwd = process.env.MAIL_PWD
let count = 0;

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });
client.connect(err => {
    const collection = client.db("maison").collection("govee");

    let imap = new Imap({
        user: myMail,
        password: myPwd,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: {
            rejectUnauthorized: false
        },
        authTimeout: 3000
    }).once('error', err => console.log('imap', err));

    imap.once('ready', () => {
        imap.openBox('INBOX', true, (err, box) => {
            if (err) throw err;
            const f = imap.seq.fetch('1:3', {
                bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)'],
                struct: true
            });
            f.on('message', function (msg, seqno) {
                const prefix = '(#' + seqno + ') ';
                msg.on('body', function (stream, info) {
                    let buffer = '';
                    stream.on('data', function (chunk) {
                        buffer += chunk.toString('utf8');
                    });
                });
                msg.once('attributes', function (attrs) {
                    const attachments = findAttachmentParts(attrs.struct);
                    for (let i = 0, len = attachments.length; i < len; ++i) {
                        const attachment = attachments[i];
                        const f = imap.fetch(attrs.uid, { //do not use imap.seq.fetch here
                            bodies: [attachment.partID],
                            struct: true
                        });
                        f.on('message', (msg) => {
                            msg.on('body', async function (stream) {
                                const room =  attachment.params.name.split('_')[0];
                                console.log('streaming room', room);

                                stream
                                    .pipe(new Decoder())
                                    .pipe(parse({from_line: 2}))
                                    .on("data", (row) => {
                                        const [rawTime, temp, hydro] = row;
                                        count++;
                                        if(count%500 === 0) console.log('tic', count)
                                        collection.insertOne({
                                            room,
                                            datetime: new Date(rawTime),
                                            temp: Number(temp),
                                            hydro: Number(hydro)
                                        })
                                    });

                                // console.log(await streamToString(stream
                                //     .pipe(decoder) // problem
                                // ));

                                // const writeStream = fs.createWriteStream('fichiers/' + room);
                                // stream
                                //     .pipe(new Decoder())
                                //     .pipe(writeStream);
                            });
                        });
                    }
                });
                msg.once('end', function () {});
            });
            f.once('error', function (err) {});
            f.once('end', function () { imap.end(); });
        });
    });
    imap.connect();

});



function findAttachmentParts(struct, attachments) {
    attachments = attachments || [];
    for (let i = 0, len = struct.length, r; i < len; ++i) {
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


function streamToString (stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    })
}

const Flint = require('node-flint');
const Spark = require('node-sparky')
const validator = require('node-sparky/validator')
const when = require('when')
const sequence = require('when/sequence')
const webhook = require('node-flint/webhook');
const express = require('express');
const fetch = require('node-fetch');
const stream = require('stream');
const Readable = require('stream').Readable;
const bodyParser = require('body-parser');
const FormData = require('form-data');
const _ = require('lodash')
const app = express();

app.use(bodyParser.json());

const snBaseURI = 'https://custom-subdomain.service-now.com/api/now/'
const incidentURI = snBaseURI + 'table/incident'
const incidentQueryURI = incidentURI + '?sysparm_query=number='
const attachmentURI = snBaseURI + 'attachment/file?'
const serviceNowAuthString = 'Basic <TOKEN>=='

// flint options - change these
var config = {
  webhookUrl: 'http://6d42a47f.ngrok.io/bot',
  token: '<SPARK BOT ACCOUNT TOKEN>',
  port: 8888
};

// can't use a spark bot account token to get messages, need a user account
var integrationConfig = {
  token: '<SPARK USER ACCOUNT>'
}

let parseRoomTitle = title => title.split('-')[1]
let createRoomTitle = ticketNumber => `SN-${ticketNumber}`

let getRoomMessages = room_id => {
  const spark = new Spark(integrationConfig)
  var promise = new Promise((resolve, reject) => {

    spark.request('get', 'messages', {roomId: room_id})
    .then(function(messages) {
      resolve(messages.body.items.reverse())
    })
    .catch(function(err) {
      console.log(err);
      reject(err)
    })
  })
  return promise
}

let checkExistingRoom = title => {
  const spark = new Spark(config)
  let promise = new Promise((resolve, reject) => {
    spark.roomsGet()
    .then(function(rooms) {
      rooms.forEach(function(room) {
        console.log(room.title);
        if(room.title === title) {
          resolve(room);
        }
      });
      resolve(null)
    })
    .catch(function(err) {
      console.log(err);
      resolve(null)
    })
  })
  return promise
}

let addPeopleToRoom = (room, email) => {
  const spark = new Spark(config)
  var add = (e, m) => {
    if(validator.isEmail(e)) {
      return spark.membershipAdd(room.id, e, m)
        .then(membership => {
          console.log('Added "%s" to room "%s"', e, room.title);
          return when(e);
        })
        .catch(err => when(false))
          .delay(flint.batchDelay);
    } else {
      return when(false);
    }
  }
  var batch = _.map(email, e => {
    e = _.toLower(e);
    return () => add(e, false).catch(err => console.log(err.stack));
  })
  return sequence(batch).then(batchResult => {
    batchResult = _.compact(batchResult);

    // if array of resulting emails is not empty...
    if(batchResult instanceof Array && batchResult.length > 0) {
      return batchResult;
    } else {
      return when.reject('invalid email(s) or email not specified');
    }
  })
}

let createStreamFromMessages = messages => {
  let s = new Readable();
  for(let i=0;i<messages.length;i++) {
    let m = messages[i]
    let entry = `${m.personEmail} @ ${m.created}:
${m.text}
--------------------------------
`
    s.push(entry)
  }
  s.push(null)
  return s;
}

let attachFileToServiceNowIncident = (sysId, readableStream) => {
  let params = `table_name=incident&table_sys_id=${sysId}&file_name=spark_chat_log.txt`
  let promise = new Promise((resolve, reject) => {
    fetch(attachmentURI + params, {
      headers: {
        Authorization: serviceNowAuthString,
        'content-type': 'text/plain'
      },
      method: 'POST',
      body: readableStream
    })
    .then(resp => resolve(resp))
  })
  return promise
}

let getServiceNowIncidentSysId = incNumber => {

  let uri = incidentQueryURI + incNumber
  var promise = new Promise((resolve, reject) => {
    fetch(uri, {
      headers: {
        Authorization: serviceNowAuthString
      }
    })
    .then(resp => resp.json())
    .then(json => {
      let sysid = json.result[0].sys_id
      resolve(sysid);
    })
  })
  return promise
}

let updateSparkRoom = (room, email) => {
  addPeopleToRoom(room, email)
}

let createSparkRoom = (title, email) => {
  const spark = new Spark(config);
  spark.roomAdd(title)
  .then(room => {
    addPeopleToRoom(room, email)
    //add bot to room
    flint.spawn(room.id)

    //send first message
    let helloMessage = {
      roomId: room.id,
      text: "Hello! Talk to me directly to issue commands. Try '@ServiceNow help'"
    }
    spark.mesageSend(helloMessage)
  })
}

let closeServiceNowIncident = sysId => {
  const closeBody = {"close_code":"Solved (Permanently)","state":"6","close_notes":"Closed in Spark"}
  const uri = incidentURI + `/${sysId}`
  var promise = new Promise((resolve, reject) => {
    fetch(uri, {
      headers: {
        Authorization: serviceNowAuthString,
        'content-type': 'application/json'
      },
      method: 'PATCH',
      body: JSON.stringify(closeBody)
    })
    .then(resp => resp.json())
    .then(json => {
      resolve(json)
    })
  })
  return promise
}

// init flint
var flint = new Flint(config);
flint.start();

// do help
flint.hears('help', function(bot, trigger) {
  bot.say(flint.showHelp('Mention my name and a command!', '---------'))
})

// close ticket
flint.hears('closeticket', function(bot, trigger) {
  bot.say('Okay, logging messages and closing room.')
  let roomId = trigger.roomId
  let snIncidentNumber = parseRoomTitle(trigger.roomTitle)
  var sys_id;

  getServiceNowIncidentSysId(snIncidentNumber)
  .then(sysid => {
    sys_id = sysid
    closeServiceNowIncident(sysid)
    .then(resp => {
      getRoomMessages(roomId)
      .then(messages => {
        var rs = createStreamFromMessages(messages)
        attachFileToServiceNowIncident(sys_id, rs)
        .then(data => {
          bot.implode()
        })
      })
    })
  })
}, 'closeticket - Closes ServiceNow incident, closes this room, and attaches Spark message log')

// define express path for incoming webhooks
app.post('/bot', webhook(flint));

//testing routes
app.get('/ticket/:number', (req, res) => {
  getServiceNowIncidentSysId(req.params.number)
  .then(sysid => res.send(sysid))
})

app.get('/ticket/:number/close', (req, res) => {
  getServiceNowIncidentSysId(req.params.number)
  .then(sysid => {
    closeServiceNowIncident(sysid)
    .then(data => res.send(data))
  })
})

app.get('/ticket/:number/attach/:roomid', (req, res) => {
  var theMessages;
  getRoomMessages(req.params.roomid)
  .then(messages => {
    theMessages = messages
    getServiceNowIncidentSysId(req.params.number)
    .then(sysid => {
      var rs = createStreamFromMessages(theMessages)
      attachFileToServiceNowIncident(sysid, rs)
      .then(data => res.send(data))
    })
  })
})

app.get('/messages/:roomid', (req, res) => {
  getRoomMessages(req.params.roomid)
  .then(messages => res.send(messages))
})
// end testing routes

// live routes
// post from servicenow
app.post('/servicenow', (req, res) => {
  let incNumber = req.body.ticketId
  let emails = req.body.emails
  let expectedTitle = createRoomTitle(incNumber)
  checkExistingRoom(expectedTitle)
  .then(existingRoom => {
    if(existingRoom !== null) {
      updateSparkRoom(existingRoom, emails)
      res.send('Room Updated')
    } else {
      createSparkRoom(expectedTitle, emails)
      res.send('Room Created')
    }
  })
})

// start express server
var server = app.listen(config.port, function () {
  flint.debug('Flint listening on port %s', config.port);
});

// gracefully shutdown (ctrl-c)
process.on('SIGINT', function() {
  flint.debug('stoppping...');
  server.close();
  flint.stop().then(function() {
    process.exit();
  });
});


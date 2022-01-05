var express = require('express');
var bodyParser = require('body-parser');
var cors = require('cors');
var boxoffice = require('./boxoffice');

const app = express();

app.use(cors());
app.use(bodyParser.urlencoded({extended : true}));
app.use(bodyParser.json());

var port = process.env.PORT || 8080;

app.post('/api/create', boxoffice.generateTicket);
app.put('/api/reprice', boxoffice.repriceTicket);
app.put('/api/transfer', boxoffice.transferTicket);
app.get('/api/ticketbyowner/:id', boxoffice.ticketFromOwner);
app.get('/api/ticketHistory/:id', boxoffice.ticketHistory);
app.get('/api/alltickets', boxoffice.queryAllTickets);
app.post('/api/delete', boxoffice.deleteTicket);
app.put('/api/lock', boxoffice.lockTicket);

app.get('/api/version', function(req, res){
    res.json({version: '1.0.0' });
});

app.listen(port);
console.log('System startet');

console.log('Access the Box Office at http://localhost:'+ port);

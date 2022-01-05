var hfc = require('fabric-client');
var path = require('path');
var util = require('util');
const fs = require('fs');

const boxoffice = {
    generateTicket,
    repriceTicket,
    transferTicket,
    ticketFromOwner,
    ticketHistory,
    queryAllTickets,
    deleteTicket,
    lockTicket
};

module.exports = boxoffice;
var firstnetwork_path = path.resolve('basic-network');
var org1tlscacert_path = path.resolve(firstnetwork_path, 'crypto-config', 'peerOrganizations', 'org1.example.com', 'tlsca', 'tlsca.org1.example.com-cert.pem');
var org1tlscacert = fs.readFileSync(org1tlscacert_path, 'utf8');
// Probably move this into a config file
const options = {
    wallet: path.join(__dirname, 'hfc-key-store'),
    userId: 'admin',
    channelId: 'mychannel',
    chaincode: 'ticketing',
    peer: 'grpc://localhost:7051',
    events: 'grpc://localhost:7053',
    orderer: 'grpc://localhost:7050'
};

async function generateTicket(req, res, next) {
    const {id, price, day, seat } = req.body;
   
    console.log(util.format('Generate Ticket {id:%s, price:%s, day:%d, seat:%s',id, price, day, seat));
    
    const client = new hfc();
    
    try {
        const [channel, peer] = await _initialize(client);
        console.log(channel);
        const tx_id = client.newTransactionID();

        var proposal_request = {
            targets: [peer],
            chaincodeId: options.chaincode,
            fcn: 'generateTicket',
            args: [id, price, day, seat],
            txId: tx_id
        };
        // notice the proposal_request has the peer defined in the 'targets' attribute

		// Send the transaction proposal to the endorsing peers.
		// The peers will run the function requested with the arguments supplied
		// based on the current state of the ledger. If the chaincode successfully
		// runs this simulation it will return a postive result in the endorsement.
		const endorsement_results = await channel.sendTransactionProposal(proposal_request);

		// The results will contain a few different items
		// first is the actual endorsements by the peers, these will be the responses
		//    from the peers. In our sammple there will only be one results since
		//    only sent the proposal to one peer.
		// second is the proposal that was sent to the peers to be endorsed. This will
		//    be needed later when the endorsements are sent to the orderer.
		const proposalResponses = endorsement_results[0];
		const proposal = endorsement_results[1];

		// check the results to decide if we should send the endorsment to be orderered
		if (proposalResponses[0] instanceof Error) {
			console.error('Failed to send Proposal. Received an error :: ' + proposalResponses[0].toString());
			throw proposalResponses[0];
		} else if (proposalResponses[0].response && proposalResponses[0].response.status === 200) {
			console.log(util.format(
				'Successfully sent Proposal and received response: Status - %s',
				proposalResponses[0].response.status));
		} else {
			const error_message = util.format('Invoke chaincode proposal:: %j', proposalResponses[i]);
			console.error(error_message);
			throw new Error(error_message);
		}

		// The proposal was good, now send to the orderer to have the transaction
		// committed.

		const commit_request = {
			proposalResponses: proposalResponses,
			proposal: proposal
		};

		//Get the transaction ID string to be used by the event processing
		const transaction_id_string = tx_id.getTransactionID();

		// create an array to hold on the asynchronous calls to be executed at the
		// same time
		const promises = [];

		// this will send the proposal to the orderer during the execuction of
		// the promise 'all' call.
		const sendPromise = channel.sendTransaction(commit_request);
		//we want the send transaction first, so that we know where to check status
		promises.push(sendPromise);

		// get an event hub that is associated with our peer
		let event_hub = channel.newChannelEventHub(peer);

		// create the asynchronous work item
		let txPromise = new Promise((resolve, reject) => {
			// setup a timeout of 30 seconds
			// if the transaction does not get committed within the timeout period,
			// report TIMEOUT as the status. This is an application timeout and is a
			// good idea to not let the listener run forever.
			let handle = setTimeout(() => {
				event_hub.unregisterTxEvent(transaction_id_string);
				event_hub.disconnect();
				resolve({event_status : 'TIMEOUT'});
			}, 30000);

			// this will register a listener with the event hub. The included callbacks
			// will be called once transaction status is received by the event hub or
			// an error connection arises on the connection.
			event_hub.registerTxEvent(transaction_id_string, (tx, code) => {
				// this first callback is for transaction event status

				// callback has been called, so we can stop the timer defined above
				clearTimeout(handle);

				// now let the application know what happened
				const return_status = {event_status : code, tx_id : transaction_id_string};
				if (code !== 'VALID') {
					console.error('The transaction was invalid, code = ' + code);
					resolve(return_status);
				} else {
					console.log('The transaction has been committed on peer ' + event_hub.getPeerAddr());
					resolve(return_status);
				}
			}, (err) => {
				//this is the callback if something goes wrong with the event registration or processing
				reject(new Error('There was a problem with the eventhub ::'+err));
			},
				{disconnect: true} //disconnect when complete
			);

			// now that we have a protective timer running and the listener registered,
			// have the event hub instance connect with the peer's event service
			event_hub.connect();
			console.log('Registered transaction listener with the peer event service for transaction ID:'+ transaction_id_string);
		});

		// set the event work with the orderer work so they may be run at the same time
		promises.push(txPromise);

		// now execute both pieces of work and wait for both to complete
		console.log('Sending endorsed transaction to the orderer');
		const results = await Promise.all(promises);

		// since we added the orderer work first, that will be the first result on
		// the list of results
		// success from the orderer only means that it has accepted the transaction
		// you must check the event status or the ledger to if the transaction was
		// committed
		if (results[0].status === 'SUCCESS') {
			console.log('Successfully sent transaction to the orderer');
		} else {
			const message = util.format('Failed to order the transaction. Error code: %s', results[0].status);
			console.error(message);
			throw new Error(message);
		}

		if (results[1] instanceof Error) {
			console.error(message);
			throw new Error(message);
		} else if (results[1].event_status === 'VALID') {
			console.log('Successfully committed the change to the ledger by the peer');
			console.log('\n\n - try running "node query.js" to see the results');
            return res.send(tx_id.getTransactionID())
		} else {
			const message = util.format('Transaction failed to be committed to the ledger due to : %s', results[1].event_status)
			console.error(message);
			throw new Error(message);
		}
	} catch(error) {
		console.log('Unable to invoke ::'+ error.toString());
	}
	return res.send("Error");
};

async function lockTicket(req, res, next) {
    const {id} = req.body;
   
    console.log(util.format('Lock Ticket {id:%s, }', id));

    const client = new hfc();
    try {
        const [channel, peer] = await _initialize(client);
        console.log(channel);
        const tx_id = client.newTransactionID();

        var proposal_request = {
            targets: [peer],
            chaincodeId: options.chaincode,
            fcn: 'lockTicket',
            args: [id],
            txId: tx_id
        };
		const endorsement_results = await channel.sendTransactionProposal(proposal_request);

		const proposalResponses = endorsement_results[0];
		const proposal = endorsement_results[1];

		if (proposalResponses[0] instanceof Error) {
			console.error('Failed to send Proposal. Received an error :: ' + proposalResponses[0].toString());
			throw proposalResponses[0];
		} else if (proposalResponses[0].response && proposalResponses[0].response.status === 200) {
			console.log(util.format(
				'Successfully sent Proposal and received response: Status - %s',
				proposalResponses[0].response.status));
		} else {
			const error_message = util.format('Invoke chaincode proposal:: %j', proposalResponses[i]);
			console.error(error_message);
			throw new Error(error_message);
		}

		const commit_request = {
			proposalResponses: proposalResponses,
			proposal: proposal
		};

		const transaction_id_string = tx_id.getTransactionID();

		const promises = [];

		const sendPromise = channel.sendTransaction(commit_request);

		promises.push(sendPromise);

		let event_hub = channel.newChannelEventHub(peer);

		let txPromise = new Promise((resolve, reject) => {
			let handle = setTimeout(() => {
				event_hub.unregisterTxEvent(transaction_id_string);
				event_hub.disconnect();
				resolve({event_status : 'TIMEOUT'});
			}, 30000);

			event_hub.registerTxEvent(transaction_id_string, (tx, code) => {

				clearTimeout(handle);

				const return_status = {event_status : code, tx_id : transaction_id_string};
				if (code !== 'VALID') {
					console.error('The transaction was invalid, code = ' + code);
					resolve(return_status);
				} else {
					console.log('The transaction has been committed on peer ' + event_hub.getPeerAddr());
					resolve(return_status);
				}
			}, (err) => {
				reject(new Error('There was a problem with the eventhub ::'+err));
			},
				{disconnect: true}
			);
			event_hub.connect();
			console.log('Registered transaction listener with the peer event service for transaction ID:'+ transaction_id_string);
		});

		promises.push(txPromise);

		console.log('Sending endorsed transaction to the orderer');
		const results = await Promise.all(promises);

		if (results[0].status === 'SUCCESS') {
			console.log('Successfully sent transaction to the orderer');
		} else {
			const message = util.format('Failed to order the transaction. Error code: %s', results[0].status);
			console.error(message);
			throw new Error(message);
		}
		if (results[1] instanceof Error) {
			console.error(message);
			throw new Error(message);
		} else if (results[1].event_status === 'VALID') {
			console.log('Successfully committed the change to the ledger by the peer');
			console.log('\n\n - try running "node query.js" to see the results');
            return res.send(tx_id.getTransactionID())
		} else {
			const message = util.format('Transaction failed to be committed to the ledger due to : %s', results[1].event_status)
			console.error(message);
			throw new Error(message);
		}
	} catch(error) {
		console.log('Unable to invoke ::'+ error.toString());
	}
	return res.send("error");
};

async function repriceTicket(req, res, next) {
    const {id, newPrice} = req.body;
    console.log(newPrice)
    console.log(util.format('Reprice Ticket {id:%s, newPrice:%s, day:%d, seat:%s',id, newPrice));

    const client = new hfc();
    try {
        const [channel, peer] = await _initialize(client);
        console.log(channel);
        const tx_id = client.newTransactionID();

        var proposal_request = {
            targets: [peer],
            chaincodeId: options.chaincode,
            fcn: 'repriceTicket',
            args: [id, newPrice],
            txId: tx_id
        };
		const endorsement_results = await channel.sendTransactionProposal(proposal_request);

		const proposalResponses = endorsement_results[0];
		const proposal = endorsement_results[1];

		if (proposalResponses[0] instanceof Error) {
			console.error('Failed to send Proposal. Received an error :: ' + proposalResponses[0].toString());
			throw proposalResponses[0];
		} else if (proposalResponses[0].response && proposalResponses[0].response.status === 200) {
			console.log(util.format(
				'Successfully sent Proposal and received response: Status - %s',
				proposalResponses[0].response.status));
		} else {
			const error_message = util.format('Invoke chaincode proposal:: %j', proposalResponses[i]);
			console.error(error_message);
			throw new Error(error_message);
		}
		const commit_request = {
			proposalResponses: proposalResponses,
			proposal: proposal
		};

		const transaction_id_string = tx_id.getTransactionID();

		const promises = [];

		const sendPromise = channel.sendTransaction(commit_request);

		promises.push(sendPromise);

		let event_hub = channel.newChannelEventHub(peer);

		let txPromise = new Promise((resolve, reject) => {
			let handle = setTimeout(() => {
				event_hub.unregisterTxEvent(transaction_id_string);
				event_hub.disconnect();
				resolve({event_status : 'TIMEOUT'});
			}, 30000);

			event_hub.registerTxEvent(transaction_id_string, (tx, code) => {

				clearTimeout(handle);

				const return_status = {event_status : code, tx_id : transaction_id_string};
				if (code !== 'VALID') {
					console.error('The transaction was invalid, code = ' + code);
					resolve(return_status);
				} else {
					console.log('The transaction has been committed on peer ' + event_hub.getPeerAddr());
					resolve(return_status);
				}
			}, (err) => {
				reject(new Error('There was a problem with the eventhub ::'+err));
			},
				{disconnect: true}
			);
			event_hub.connect();
			console.log('Registered transaction listener with the peer event service for transaction ID:'+ transaction_id_string);
		});
		promises.push(txPromise);

		console.log('Sending endorsed transaction to the orderer');
		const results = await Promise.all(promises);

		if (results[0].status === 'SUCCESS') {
			console.log('Successfully sent transaction to the orderer');
		} else {
			const message = util.format('Failed to order the transaction. Error code: %s', results[0].status);
			console.error(message);
			throw new Error(message);
		}
		if (results[1] instanceof Error) {
			console.error(message);
			throw new Error(message);
		} else if (results[1].event_status === 'VALID') {
			console.log('Successfully committed the change to the ledger by the peer');
			console.log('\n\n - try running "node query.js" to see the results');
            return res.send(tx_id.getTransactionID())
		} else {
			const message = util.format('Transaction failed to be committed to the ledger due to : %s', results[1].event_status)
			console.error(message);
			throw new Error(message);
		}
	} catch(error) {
		console.log('Unable to invoke ::'+ error.toString());
	}
	return res.send("Error");
};

async function transferTicket(req, res, next) {
    const {id, newOwner} = req.body;
   
    console.log(util.format('Transfer Ticket {id:%s, newPrice:%s, day:%d, seat:%s',id, newOwner));

    const client = new hfc();

    try {
        const [channel, peer] = await _initialize(client);
        console.log(channel);
        const tx_id = client.newTransactionID();

        var proposal_request = {
            targets: [peer],
            chaincodeId: options.chaincode,
            fcn: 'transferTicket',
            args: [id, newOwner],
            txId: tx_id
        };
		const endorsement_results = await channel.sendTransactionProposal(proposal_request);

		const proposalResponses = endorsement_results[0];
		const proposal = endorsement_results[1];

		if (proposalResponses[0] instanceof Error) {
			console.error('Failed to send Proposal. Received an error :: ' + proposalResponses[0].toString());
			throw proposalResponses[0];
		} else if (proposalResponses[0].response && proposalResponses[0].response.status === 200) {
			console.log(util.format(
				'Successfully sent Proposal and received response: Status - %s',
				proposalResponses[0].response.status));
		} else {
			const error_message = util.format('Invoke chaincode proposal:: %j', proposalResponses[i]);
			console.error(error_message);
			throw new Error(error_message);
		}

		const commit_request = {
			proposalResponses: proposalResponses,
			proposal: proposal
		};

		const transaction_id_string = tx_id.getTransactionID();

		const promises = [];

		const sendPromise = channel.sendTransaction(commit_request);
		promises.push(sendPromise);

		let event_hub = channel.newChannelEventHub(peer);

		let txPromise = new Promise((resolve, reject) => {
			let handle = setTimeout(() => {
				event_hub.unregisterTxEvent(transaction_id_string);
				event_hub.disconnect();
				resolve({event_status : 'TIMEOUT'});
			}, 30000);

			event_hub.registerTxEvent(transaction_id_string, (tx, code) => {
				clearTimeout(handle);
				const return_status = {event_status : code, tx_id : transaction_id_string};
				if (code !== 'VALID') {
					console.error('The transaction was invalid, code = ' + code);
					resolve(return_status);
				} else {
					console.log('The transaction has been committed on peer ' + event_hub.getPeerAddr());
					resolve(return_status);
				}
			}, (err) => {
				reject(new Error('There was a problem with the eventhub ::'+err));
			},
				{disconnect: true} 
			);
			event_hub.connect();
			console.log('Registered transaction listener with the peer event service for transaction ID:'+ transaction_id_string);
		});
		promises.push(txPromise);
		console.log('Sending endorsed transaction to the orderer');
		const results = await Promise.all(promises);

		if (results[0].status === 'SUCCESS') {
			console.log('Successfully sent transaction to the orderer');
		} else {
			const message = util.format('Failed to order the transaction. Error code: %s', results[0].status);
			console.error(message);
			throw new Error(message);
		}
		if (results[1] instanceof Error) {
			console.error(message);
			throw new Error(message);
		} else if (results[1].event_status === 'VALID') {
			console.log('Successfully committed the change to the ledger by the peer');
			console.log('\n\n - try running "node query.js" to see the results');
            return res.send(tx_id.getTransactionID())
		} else {
			const message = util.format('Transaction failed to be committed to the ledger due to : %s', results[1].event_status)
			console.error(message);
			throw new Error(message);
		}
	} catch(error) {
		console.log('Unable to invoke ::'+ error.toString());
	}
	return res.send("Error");
};

async function lockTicket(req, res, next) {
    const {id} = req.body;
   
    console.log(util.format('Lock Ticket {id:%s, }', id));

    const client = new hfc();

    try {
        const [channel, peer] = await _initialize(client);
        console.log(channel);
        const tx_id = client.newTransactionID();

        var proposal_request = {
            targets: [peer],
            chaincodeId: options.chaincode,
            fcn: 'lockTicket',
            args: [id],
            txId: tx_id
        };
		const endorsement_results = await channel.sendTransactionProposal(proposal_request);

		const proposalResponses = endorsement_results[0];
		const proposal = endorsement_results[1];

		if (proposalResponses[0] instanceof Error) {
			console.error('Failed to send Proposal. Received an error :: ' + proposalResponses[0].toString());
			throw proposalResponses[0];
		} else if (proposalResponses[0].response && proposalResponses[0].response.status === 200) {
			console.log(util.format(
				'Successfully sent Proposal and received response: Status - %s',
				proposalResponses[0].response.status));
		} else {
			const error_message = util.format('Invoke chaincode proposal:: %j', proposalResponses[i]);
			console.error(error_message);
			throw new Error(error_message);
		}
		const commit_request = {
			proposalResponses: proposalResponses,
			proposal: proposal
		};

		const transaction_id_string = tx_id.getTransactionID();

		const promises = [];

		const sendPromise = channel.sendTransaction(commit_request);
		promises.push(sendPromise);

		let event_hub = channel.newChannelEventHub(peer);

		let txPromise = new Promise((resolve, reject) => {
			let handle = setTimeout(() => {
				event_hub.unregisterTxEvent(transaction_id_string);
				event_hub.disconnect();
				resolve({event_status : 'TIMEOUT'});
			}, 30000);

			event_hub.registerTxEvent(transaction_id_string, (tx, code) => {
				clearTimeout(handle);
				const return_status = {event_status : code, tx_id : transaction_id_string};
				if (code !== 'VALID') {
					console.error('The transaction was invalid, code = ' + code);
					resolve(return_status);
				} else {
					console.log('The transaction has been committed on peer ' + event_hub.getPeerAddr());
					resolve(return_status);
				}
			}, (err) => {
				reject(new Error('There was a problem with the eventhub ::'+err));
			},
				{disconnect: true}
			);
			event_hub.connect();
			console.log('Registered transaction listener with the peer event service for transaction ID:'+ transaction_id_string);
		});

		promises.push(txPromise);

		console.log('Sending endorsed transaction to the orderer');
		const results = await Promise.all(promises);

		if (results[0].status === 'SUCCESS') {
			console.log('Successfully sent transaction to the orderer');
		} else {
			const message = util.format('Failed to order the transaction. Error code: %s', results[0].status);
			console.error(message);
			throw new Error(message);
		}
		if (results[1] instanceof Error) {
			console.error(message);
			throw new Error(message);
		} else if (results[1].event_status === 'VALID') {
			console.log('Successfully committed the change to the ledger by the peer');
			console.log('\n\n - try running "node query.js" to see the results');
            return res.send(tx_id.getTransactionID())
		} else {
			const message = util.format('Transaction failed to be committed to the ledger due to : %s', results[1].event_status)
			console.error(message);
			throw new Error(message);
		}
	} catch(error) {
		console.log('Unable to invoke ::'+ error.toString());
	}
	return res.send("error");
};

async function ticketFromOwner(req, res, next){
    const {id:owner} = req.params;

    console.log(util.format('Ticket by Owner ', owner));
    
    const client = new hfc();

    try {
        const [channel, peer] = await _initialize(client);
        console.log(channel);
        const request = {
            targets: [peer],
            chaincodeId: options.chaincode,
            txId: client.newTransactionID(),
            fcn: 'queryTicketByOwner',
            args: [owner]
        };
        const response = await channel.queryByChaincode(request);
        console.log(response)
        res.status(200).send(JSON.parse(response));
    } catch (err) {
        res.status(400).send(util.format('Caught error: %s', err));
    }
}

async function ticketHistory(req, res, next) {
    const {id:ticketId} = req.params;

    console.log(util.format('Ticket History: %s', ticketId));

    const client = new hfc();

    try {
        const [channel, peer] = await _initialize(client);
        const request = {
            targets: [peer],
            chaincodeId: options.chaincode,
            txid: client.newTransactionID(),
            fcn: 'ticketHistory',
            args: [ticketId]
        };
        const response = await channel.queryByChaincode(request);
        console.log(response)
        res.status(200).send(JSON.parse(response));
    } catch (err) {
        res.status(400).send(util.format('Caught error: %s', err));
    }
}

async function queryAllTickets(req, res) {
    console.log(util.format('Query all Tickets'));

    const client = new hfc();
    try {
        const [channel, peer] = await _initialize(client);
        const request = {
            targets: [peer],
            chaincodeId: options.chaincode,
            txid: client.newTransactionID(),
            fcn: 'queryAllTickets',
            args: []
        };
        const response = await channel.queryByChaincode(request);
        res.status(200).send(JSON.parse(response));
    } catch (err) {
        res.status(400).send(util.format('Caught error: %s', err));
    }
}

async function deleteTicket(req, res){
    const {id} = req.body;
    console.log(id);
    const client = new hfc();
    try {
        const [channel, peer] = await _initialize(client);
        const request = {
            targets: [peer],
            chaincodeId: options.chaincode,
            txid: client.newTransactionID(),
            fcn: 'deleteTicket',
            args: [id]
        };

        console.log(request)
        const response = await channel.queryByChaincode(request);
        return res.status(200).send(JSON.parse(util.format('{\n"Success":"Deleted Ticket %s"\n}', id)));
    } catch (err) {
        res.status(400).send(util.format('Caught error: %s', err));
    }
 }

async function _initialize(client) {
    const channel = client.newChannel('mychannel')
    
    const peer = client.newPeer(options.peer)
    const wallet = await hfc.newDefaultKeyValueStore({ path: options.wallet });
    client.setStateStore(wallet);

    const crypto_suite = hfc.newCryptoSuite();
    const crypto_store = hfc.newCryptoKeyStore({ path: options.wallet });
    
    crypto_suite.setCryptoKeyStore(crypto_store);
    client.setCryptoSuite(crypto_suite);
    
    const user = await client.getUserContext(options.userId, true);
    if (user == undefined || !user.isEnrolled()) {
        console.error('User is not enrolled. Please use registerUser.js to register');
    }
    await channel.initialize({ discover: true, asLocalhost: true, target: peer });
    console.log('Used service discovery to initialize the channel');
    return [channel, peer];
}
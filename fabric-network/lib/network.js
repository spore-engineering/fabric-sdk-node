/**
 * Copyright 2018 IBM All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';
const FabricConstants = require('fabric-client/lib/Constants');
const Contract = require('./contract');
const EventHubFactory = require('fabric-network/lib/impl/event/eventhubfactory');

const logger = require('./logger').getLogger('Network');
const util = require('util');

/**
 * A Network represents the set of peers in a Fabric network.
 * Applications should get a Network instance using the
 * gateway's [getNetwork]{@link Gateway#getNetwork} method.
 */

class Network {

	/*
	 * Network constructor for internal use only.
	 * @param {Gateway} gateway The owning gateway instance
	 * @param {Channel} channel The fabric-client channel instance
	 * @ignore
	 */
	constructor(gateway, channel) {
		logger.debug('in Network constructor');

		this.gateway = gateway;
		this.channel = channel;
		this.contracts = new Map();
		this.eventHubFactory = new EventHubFactory(channel);
		this.initialized = false;
	}

	/**
     * create a map of mspId's and the network peers in those mspIds
     * @private
     * @memberof Network
     */
	_mapPeersToMSPid() {
		logger.debug('in _mapPeersToMSPid');

		// TODO: assume 1-1 mapping of mspId to org as the node-sdk makes that assumption
		// otherwise we would need to find the channel peer in the network config collection or however SD
		// stores things

		const peerMap = new Map();
		const channelPeers = this.channel.getPeers();

		// bug in service discovery, peers don't have the associated mspid
		if (channelPeers.length > 0) {
			for (const channelPeer of channelPeers) {
				const mspId = channelPeer.getMspid();
				if (mspId) {
					let peerList = peerMap.get(mspId);
					if (!peerList) {
						peerList = [];
						peerMap.set(mspId, peerList);
					}
					peerList.push(channelPeer);
				}
			}
		}
		if (peerMap.size === 0) {
			const msg = 'no suitable peers associated with mspIds were found';
			logger.error('_mapPeersToMSPid: ' + msg);
			throw new Error(msg);
		}
		return peerMap;
	}

	/**
     * initialize the channel if it hasn't been done
     * @private
     */
	async _initializeInternalChannel(discovery) {
		logger.debug('in _initializeInternalChannel');

		//TODO: Should this work across all peers or just orgs peers ?
		//TODO: should sort peer list to the identity org initializing the channel.
		//TODO: Candidate to push to low level node-sdk.

		const ledgerPeers = this.channel.getPeers().filter((cPeer) => {
			return cPeer.isInRole(FabricConstants.NetworkConfig.LEDGER_QUERY_ROLE);
		});

		if (ledgerPeers.length === 0) {
			const msg = 'no suitable peers available to initialize from';
			logger.error('_initializeInternalChannel: ' + msg);
			throw new Error(msg);
		}

		let ledgerPeerIndex = 0;
		let success = false;

		while (!success) {
			try {
				const initOptions = {
					target: ledgerPeers[ledgerPeerIndex],
					discover: discovery.enabled,
					asLocalhost: discovery.asLocalhost
				};

				await this.channel.initialize(initOptions);

				success = true;
			} catch(error) {
				if (ledgerPeerIndex >= ledgerPeers.length - 1) {
					const msg = util.format('Unable to initialize channel. Attempted to contact %j Peers. Last error was %s', ledgerPeers.length, error);
					logger.error('_initializeInternalChannel: ' + msg);
					throw new Error(msg);
				}
				ledgerPeerIndex++;
			}
		}
	}

	/**
	 * Initialize this network instance
	 * @private
	 * @memberof Network
	 */
	async _initialize(discover) {
		logger.debug('in initialize');

		if (this.initialized) {
			return;
		}

		await this._initializeInternalChannel(discover);
		const peerMap = this._mapPeersToMSPid();
		this.queryHandler = await this.gateway._createQueryHandler(this.channel, peerMap);
		this.initialized = true;
	}

	getChannel() {
		logger.debug('in getChannel');

		return this.channel;
	}

	/**
	 * Returns an instance of a contract (chaincode) on the current network
	 * @param {string} chaincodeId the chaincode Identifier
	 * @param {string} [namespace] optional namespace for the contract
	 * @returns {Contract} the contract
	 * @api
	 */
	getContract(chaincodeId,namespace='') {
		logger.debug('in getContract');
		if (!this.initialized) {
			throw new Error('Unable to get contract as network has failed to initialize');
		}
		const key = `${chaincodeId}:${namespace}`;
		let contract = this.contracts.get(key);
		if (!contract) {
			contract = 	new Contract(
				this,
				chaincodeId,
				this.gateway,
				this.queryHandler,
				namespace
			);
			this.contracts.set(key, contract);
		}
		return contract;
	}

	_dispose() {
		logger.debug('in _dispose');

		// Danger as this cached in gateway, and also async so how would
		// network._dispose() followed by network.initialize() be safe ?
		// make this private is the safest option.
		this.contracts.clear();

		if (this.queryHandler) {
			this.queryHandler.dispose();
		}

		this.channel.close(); // Tidies up event hubs obtained from the channel

		this.initialized = false;
	}

	/**
	 * Get the event hub factory for this network.
	 * @private
	 * @returns {EventHubFactory} An event hub factory.
	 */
	getEventHubFactory() {
		return this.eventHubFactory;
	}
}

module.exports = Network;

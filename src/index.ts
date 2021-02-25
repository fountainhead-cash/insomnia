import { config } from './config';
import fs from 'fs';
import { ElectrumCluster, ElectrumClient } from 'electrum-cash';
import { GraphSearchClient, TrustedValidationReply } from 'grpc-graphsearch-node';
import BigNumber from 'bignumber.js';
import express from 'express';
import bodyParser from 'body-parser';
import bitcore from 'bitcore-lib-cash';
import {
  GenesisParseResult,
  MintParseResult,
  SendParseResult,
  parseSLP
} from 'slp-parser';
import { toCashAddress, toSlpAddress } from 'bchaddrjs-slp';
import morgan from 'morgan';
import rateLimit from "express-rate-limit";

let electrum = null;
if (config.electrum.connectionType === 'cluster') {
  electrum = new ElectrumCluster(
    config.electrum.application,
    config.electrum.version,
    config.electrum.confidence,
    config.electrum.distribution,
  );

  for (const server of config.electrum.servers) {
    const [host, port] = server.split(':');
    if (typeof(host) === 'undefined' || typeof(port) === 'undefined') {
      throw new Error("server field has bad format (should be host:port)");
    }
    electrum.addServer(host, port);
  }
} else if (config.electrum.connectionType === 'client') {
  const [hostname, port] = config.electrum.servers[0].split(':');
  electrum = new ElectrumClient(
    config.electrum.application,
    config.electrum.version,
    hostname,
    parseInt(port, 10)
  );
} else {
  console.log('unknown electrum.connectionType');
  process.exit(1);
}

let gspp = new GraphSearchClient({
  url:          config.gspp.url,
  rootCertPath: config.gspp.cert ? config.gspp.cert : undefined,
});


const apiLimiter = rateLimit({
  ...config.ratelimit,
  ...{
    message: {
      success: false,
      message: "Too many requests"
    }
  }
});

const app = express();
app.use(bodyParser.text({ limit: '100kb' }));
app.disable('x-powered-by');
app.use('/v1/', apiLimiter);

app.use(express.static('public'));

app.use(morgan('dev', {
  // skip: (req, res) => res.statusCode < 400
}));

const router = express.Router();
app.use('/v1', router);

async function blockchainTransactionGet(transactionID: string) {
  var electrumResponse = await electrum.request('blockchain.transaction.get', transactionID, false);

  if (electrumResponse instanceof Error) {
    throw electrumResponse;
  }

  return electrumResponse;
}

function hydrateTransaction(transactionHex: string): any {
  const tx = new bitcore.Transaction(transactionHex);
  let response = tx.toJSON();
  for (let input of response.inputs) {
    try {
      const script = new bitcore.Script(input.script);
      input.cashAddress = script.toAddress().toString();
      input.slpAddress = toSlpAddress(input.cashAddress);
    } catch (e) {
      input.cashAddress = null;
      input.slpAddress = null;
    }
  }
  for (let output of response.outputs) {
    try {
      const script = new bitcore.Script(output.script);
      output.cashAddress = script.toAddress().toString();
      output.slpAddress = toSlpAddress(output.cashAddress);
    } catch (e) {
      output.cashAddress = null;
      output.slpAddress = null;
    }
  }
  if (response.outputs.length > 0) {
    try {
      const parsed = parseSLP(response.outputs[0].script);
      const fmtd: any = parsed;
      if (parsed.transactionType === "GENESIS") {
        let o = parsed.data as GenesisParseResult;
        fmtd.data.ticker       = o.ticker.toString('hex');
        fmtd.data.name         = o.ticker.toString('hex');
        fmtd.data.documentUri  = o.documentUri.toString('hex');
        fmtd.data.documentHash = o.documentHash.toString('hex');
      }
      else if (parsed.transactionType === "MINT") {
        let o = parsed.data as MintParseResult;
        fmtd.data.tokenId = o.tokenId.toString('hex');
      }
      else if (parsed.transactionType === "SEND") {
        let o = parsed.data as SendParseResult;
        fmtd.data.tokenId  = o.tokenId.toString('hex');
      }

      response.slp = parsed;
    } catch (e) {
      response.slp = {
        error: e.message
      }
    }
  }
  return response;
}

router.get('/tx/data/:txid', async (req, res) => {
  const transactionID = req.params.txid;
  const verbose = req.query.verbose === 'true';
  try {
    var electrumResponse = await blockchainTransactionGet(transactionID);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  let response = null;
  if (! verbose) {
    response = electrumResponse;
  } else {
    try {
      response = hydrateTransaction(electrumResponse);
    }catch (e) {
      return res.status(500).send({
        success: false,
        message: e.message,
      });
    }
  }

  return res.send({
    success: true,
    tx:      response,
  });
});

router.get('/tx/merkle/:txid/:height', async (req, res) => {
  try {
    if (isNaN(req.params.height as any)) {
      throw new Error('invalid parameter height; expected integer');
    }
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: e.message,
    });
  }
  const transactionID = req.params.txid;
  const blockHeight = parseInt(req.params.height, 10);
  try {
    var electrumResponse = await electrum.request('blockchain.transaction.get_merkle', transactionID, blockHeight);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    merkle: electrumResponse.merkle,
  });
});

router.post('/tx/broadcast', async (req, res) => {
  const transactionHex = req.body;
  try {
    var electrumResponse = await electrum.request('blockchain.transaction.broadcast', transactionHex);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  if (! electrumResponse.toString().match(/^[a-f0-9]{64}$/)) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.toString(),
    });
  }

  return res.send({
    success: true,
    txid: electrumResponse,
  });
});

router.post('/tx/slp_prebroadcast', async (req, res) => {
  const transactionHex = req.body;
  const tx = new bitcore.Transaction(transactionHex);

  const slpTaggedInputTransactions: any[] = [];
  for (const input of tx.inputs) {
    const itxid: Buffer = input.prevTxId;
    const ivout: number = input.outputIndex;

    try {
      const itxres = await blockchainTransactionGet(itxid.toString('hex'));
      const itxd = hydrateTransaction(itxres);

      if (typeof itxd.slp.error === 'undefined') {
        itxd.relevantSlpOutput = ivout;
        if (itxd.slp.transactionType === 'GENESIS') {
          itxd.slp.data.tokenId = itxd.hash;
        }
        slpTaggedInputTransactions.push(itxd);
      }
    } catch (e) {
      return res.status(400).send({
        success: false,
        message: `could not retrieve input ${itxid.toString('hex')}:${ivout}`,
      });
    }
  }

  const gsppResults = await Promise.allSettled(
    slpTaggedInputTransactions.map((txi) => gspp.trustedValidationFor({
      hash: txi.hash,
      reversedHashOrder: true,
    }))
  );

  for (let idx=0; idx<gsppResults.length; ++idx) {
    const o = gsppResults[idx];

    if (o.status !== 'fulfilled') {
      return res.status(400).send({
        success: false,
        message: `could not retrieve all gs++ validity results`,
      });
    }

    const valid = o.value.getValid();

    slpTaggedInputTransactions[idx].validity = {
      gspp: {
        valid,
      }
    };
  }

  let relevantSlpInputs: any[] = [];
  let hasMintBaton = false;
  for (let itx of slpTaggedInputTransactions) {
    const rvout = itx.relevantSlpOutput;
    let slpValue = new BigNumber(0);

    if (itx.slp.transactionType === 'SEND') {
      // amounts dont include 1st opreturn message so we minus 1
      if (rvout-1 < itx.slp.data.amounts.length) {
        slpValue = itx.slp.data.amounts[rvout-1];
      }
    } else /* mint and genesis */ {
      if (rvout === 1) {
        slpValue = itx.slp.data.qty;
      }

      if (itx.slp.data.mintBatonVout > 0) {
        // TODO check off by 1
        if (itx.outputs.length > itx.slp.data.mintBatonVout) {
          if (rvout === itx.slp.data.mintBatonVout) {
            hasMintBaton = true;
          }
        }
      }
    }

    if (slpValue.gt(0)) {
      relevantSlpInputs.push({
        tokenType:  itx.slp.tokenType,
        tokenId:    itx.slp.data.tokenId,
        slpValue,
      });
    }
  }

  const allSameTypes = relevantSlpInputs.every((v, i, arr) =>
    v.slpValue.eq(0)
      ? true
      : (
           v.tokenType === arr[0].tokenType
        && v.tokenId   === arr[0].tokenId
      )
  );

  if (! allSameTypes) {
    return res.status(400).send({
      success: false,
      message: `tokenType or tokenId mismatch related burn detected`,
    });
  }

  const totalSlpInputValue = relevantSlpInputs.reduce(
    (a, v) => a.plus(v.slpValue),
    new BigNumber(0)
  );

  const txd = hydrateTransaction(transactionHex);

  if (typeof txd.slp.error !== 'undefined') {
    return res.status(400).send({
      success: false,
      message: `error in slp metadata ${txd.slp.error}`,
    });
  }

  if (relevantSlpInputs.length > 0) {
    if (txd.slp.tokenType !== relevantSlpInputs[0].tokenType) {
      return res.status(400).send({
        success: false,
        message: `input's tokenType different than transactions causing burn`,
      });
    }

    if (txd.slp.data.tokenId !== relevantSlpInputs[0].tokenId) {
      return res.status(400).send({
        success: false,
        message: `input's tokenId different than transactions causing burn`,
      });
    }
  }

  // TODO handle mints / mint baton


  let totalSlpOutputValue = new BigNumber(0);
  if (txd.slp.transactionType === 'SEND') {
    totalSlpOutputValue = txd.slp.data.amounts.reduce(
      (a, v) => a.plus(v),
      new BigNumber(0)
    );
  } else /* mint and genesis */ {
    totalSlpOutputValue = txd.slp.data.qty;
  }

  if (txd.slp.transactionType === 'GENESIS') {
    // TODO allow burning of mint baton
    if (hasMintBaton) {
      return res.status(400).send({
        success: false,
        message: `baton input for GENESIS type would cause burning of baton`,
      });
    }
    if (txd.slp.data.mintBatonVout >= txd.outputs.length) {
      return res.status(400).send({
        success: false,
        message: `mint baton would be burned as there isnt a corresponding bch output`,
      });
    }
  }
  else if (txd.slp.transactionType === 'MINT') {
    if (! hasMintBaton) {
      return res.status(400).send({
        success: false,
        message: `transactionType mint without corresponding baton input`,
      });
    }
    if (totalSlpInputValue.gt(0)) {
      return res.status(400).send({
        success: false,
        message: `slp inputs greater than 0 for mint`,
      });
    }
    // TODO allow ending of mint baton
    if (txd.slp.data.mintBatonVout === 0) {
      return res.status(400).send({
        success: false,
        message: `mint baton output not set`,
      });
    }
    // TODO see above?
    if (txd.outputs.length < 2) {
      return res.status(400).send({
        success: false,
        message: `there is no output for mint to credit`,
      });
    }
    if (txd.slp.data.mintBatonVout >= txd.outputs.length) {
      return res.status(400).send({
        success: false,
        message: `mint baton would be burned as there isnt a corresponding bch output`,
      });
    }
  }
  else if (txd.slp.transactionType === 'SEND') {
    // TODO allow burning of mint baton
    if (hasMintBaton) {
      return res.status(400).send({
        success: false,
        message: `baton input for SEND type would cause burning of baton`,
      });
    }
    if (totalSlpOutputValue.gt(totalSlpInputValue)) {
      return res.status(400).send({
        success: false,
        message: `slp outputs greater than inputs`,
      });
    }
    if (txd.outputs.length < txd.slp.data.amounts.length + 1) {
      return res.status(400).send({
        success: false,
        message: `fewer bch outputs than slp outputs`,
      });
    }
  }


  // TODO allow burn of up to X coins via parameter
  if (totalSlpOutputValue.lt(totalSlpInputValue)) {
    return res.status(400).send({
      success: false,
      message: `slp outputs less than inputs`,
    });
  }

  return res.status(200).send({
    success: true,
    message: 'transaction does not burn tokens'
  });
});

router.get('/block/headers/:height', async (req, res) => {
  try {
    if (isNaN(req.params.height as any)) {
      throw new Error('invalid parameter height; expected integer');
    }
    if (req.query.count && isNaN(req.query.count as any)) {
      throw new Error('invalid parameter count; expected integer');
    }
    if (req.query.cp_height && isNaN(req.query.cp_height as any)) {
      throw new Error('invalid parameter cp_height; expected integer');
    }
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: e.message,
    });
  }
  const blockHeight = parseInt(req.params.height, 10);
  const count = parseInt(req.query.count as string, 10) || 1;
  const cpHeight = parseInt(req.query.cp_height as string, 10) || 0;
  try {
    var electrumResponse = await electrum.request('blockchain.block.headers', blockHeight, count, cpHeight);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  try {
    if (electrumResponse instanceof Error) {
      throw electrumResponse;
    }
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    headers: electrumResponse.hex.match(/.{160}/g),
  });
});


const addressToScripthash = (addrstr: string) => {
  addrstr = toCashAddress(addrstr); // allow conversion of different address types
  const address = bitcore.Address.fromString(addrstr)
  const script = bitcore.Script.fromAddress(address);
  const scripthash = bitcore.crypto.Hash.sha256(script.toBuffer()).reverse().toString('hex');

  return scripthash;
}

router.get('/address/balance/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.get_balance', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    confirmed: electrumResponse.confirmed,
    unconfirmed: electrumResponse.unconfirmed,
  });
});

router.get('/address/history/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.get_history', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    txs: electrumResponse,
  });
});

router.get('/address/mempool/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.get_mempool', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    txs: electrumResponse,
  });
});

router.get('/address/utxos/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.listunspent', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    utxos: electrumResponse,
  });
});


(async () => {
  if (config.electrum.connectionType === 'cluster') {
    await electrum.ready();
  } else if (config.electrum.connectionType === 'client') {
    await electrum.connect();
  }
  app.listen(config.port);
  console.log('listening on port', config.port);

  process.on('beforeExit', async () => {
    if (config.electrum.connectionType === 'cluster') {
      await electrum.shutdown();
    } else if (config.electrum.connectionType === 'client') {
      await electrum.disconnect();
    }
    process.exit(0);
  });
})();

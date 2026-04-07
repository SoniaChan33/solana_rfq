import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    SystemProgram,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    sendAndConfirmTransaction,
    Ed25519Program,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
    createAssociatedTokenAccountInstruction,
    createInitializeMintInstruction,
    createMintToInstruction,
    createApproveInstruction,
    getAssociatedTokenAddress,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    MintLayout,
} from '@solana/spl-token';
import BN = require('bn.js');
import bs58 from 'bs58';

// Load environment variables from .env file
dotenv.config();

// ========== Configuration Constants ==========
const PROGRAM_ID = new PublicKey('G29y9AUmrm3CwSifUbPMbUWmqLBKhjUcTCekYLtnegxG');
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'http://127.0.0.1:8899';
const AGGREGATOR_ENDPOINT = process.env.AGGREGATOR_URL || 'http://127.0.0.1:8080';
const RFQ_RECORD_SEED = 'rfq_record';
const RFQ_AUTHORITY_SEED = 'rfq_authority';

// Load Maker private key from environment
const MAKER_PRIVATE_KEY_B58 = process.env.MAKER_PRIVATE_KEY;
if (!MAKER_PRIVATE_KEY_B58) {
    console.error('[Config] MAKER_PRIVATE_KEY not found in environment variables');
    process.exit(1);
}

// Decode MAKER_PRIVATE_KEY and create Keypair
const makerKeyPairBytes = bs58.decode(MAKER_PRIVATE_KEY_B58);
if (makerKeyPairBytes.length < 64) {
    console.error('[Config] Invalid MAKER_PRIVATE_KEY length. Expected at least 64 bytes.');
    process.exit(1);
}
const makerSecretKey = makerKeyPairBytes.slice(0, 64);
const makerKeypair = Keypair.fromSecretKey(makerSecretKey);
const makerPubkeyFromEnv = makerKeypair.publicKey;

console.log(`[Config] Maker public key from .env: ${makerPubkeyFromEnv.toBase58()}`);

// ========== Utility Functions ==========

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

function findPdaAddress(seeds: (Uint8Array | Buffer)[], programId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(seeds, programId);
}

// ========== Test Helper: Create Test Tokens and Accounts ==========

interface TokenSetup {
    mint: PublicKey;
    takerAta: PublicKey;
    makerAta: PublicKey;
}

async function setupTestToken(
    connection: Connection,
    payer: Keypair,
    taker: PublicKey,
    maker: PublicKey,
    mintKeypair: Keypair
): Promise<TokenSetup> {
    console.log(`  [TokenSetup] Initializing test token mint: ${mintKeypair.publicKey.toBase58()}`);

    const lamports = await connection.getMinimumBalanceForRentExemption(MintLayout.span);
    const createMintAccountIx = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        lamports,
        space: MintLayout.span,
        programId: TOKEN_PROGRAM_ID,
    });

    const initMintIx = createInitializeMintInstruction(
        mintKeypair.publicKey,
        9,
        payer.publicKey,
        payer.publicKey
    );

    const takerAta = await getAssociatedTokenAddress(mintKeypair.publicKey, taker, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const makerAta = await getAssociatedTokenAddress(mintKeypair.publicKey, maker, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    const createTakerAtaIx = createAssociatedTokenAccountInstruction(payer.publicKey, takerAta, taker, mintKeypair.publicKey);
    const createMakerAtaIx = createAssociatedTokenAccountInstruction(payer.publicKey, makerAta, maker, mintKeypair.publicKey);

    const mintToTakerIx = createMintToInstruction(mintKeypair.publicKey, takerAta, payer.publicKey, 1_000_000_000);
    const mintToMakerIx = createMintToInstruction(mintKeypair.publicKey, makerAta, payer.publicKey, 1_000_000_000);

    const tx = new Transaction().add(
        createMintAccountIx, initMintIx, createTakerAtaIx, createMakerAtaIx, mintToTakerIx, mintToMakerIx
    );

    await sendAndConfirmTransaction(connection, tx, [payer, mintKeypair], { skipPreflight: true });

    console.log(`  [TokenSetup] Taker ATA: ${takerAta.toBase58()}`);
    console.log(`  [TokenSetup] Maker ATA: ${makerAta.toBase58()}`);

    return { mint: mintKeypair.publicKey, takerAta, makerAta };
}

// ========== Main Test Function ==========

async function runRfqTest() {
    console.log('=== Solana RFQ End-to-End Test Suite ===\n');

    const connection = new Connection(RPC_ENDPOINT, 'confirmed');

    try {
        const version = await connection.getVersion();
        console.log(`[Connection] Connected to Solana node: ${version['solana-core']}\n`);
    } catch (error) {
        console.error('[Connection] Failed to connect to Solana node. Ensure local validator is running.');
        process.exit(1);
    }

    // Step 0: Initialize Test Keypairs
    console.log('Step 0: Initialize Test Keypairs');
    const takerKeypair = Keypair.generate();
    const payerKeypair = Keypair.generate();

    console.log('  [KeyGen] Provisioning SOL to test accounts...');
    const airdropPromises = [takerKeypair.publicKey, payerKeypair.publicKey, makerPubkeyFromEnv].map(
        pk => connection.requestAirdrop(pk, 10 * LAMPORTS_PER_SOL)
    );
    await Promise.all(airdropPromises);
    console.log(`  [KeyGen] Taker: ${takerKeypair.publicKey.toBase58()}`);
    console.log(`  [KeyGen] Payer: ${payerKeypair.publicKey.toBase58()}`);
    console.log(`  [KeyGen] Maker (from .env): ${makerPubkeyFromEnv.toBase58()}\n`);

    // Step 0.1: Verify Maker Info from Backend
    console.log('Step 0.1: Verify Maker Info from Aggregator Backend');
    try {
        const makerInfoResponse = await fetch(`${AGGREGATOR_ENDPOINT}/maker-info`);
        const makerInfo = await makerInfoResponse.json() as { maker_id: string; maker_pubkey: string; quote_expiry_seconds: number };
        console.log(`  [MakerInfo] Maker ID: ${makerInfo.maker_id}`);
        console.log(`  [MakerInfo] Maker Pubkey: ${makerInfo.maker_pubkey}`);
        console.log(`  [MakerInfo] Quote Expiry: ${makerInfo.quote_expiry_seconds}s`);

        if (makerInfo.maker_pubkey !== makerPubkeyFromEnv.toBase58()) {
            console.error(`  [MakerInfo] ERROR: Backend Maker pubkey does not match .env!`);
            process.exit(1);
        }
        console.log(`  [MakerInfo] ✓ Backend Maker pubkey matches .env configuration\n`);
    } catch (error) {
        console.error('[MakerInfo] Failed to fetch maker info. Ensure backend is running.');
        process.exit(1);
    }

    // Step 0.2: Provision Mock Token Infrastructure
    console.log('Step 0.2: Provision Mock Token Infrastructure');
    const baseMintKeypair = Keypair.generate();
    const quoteMintKeypair = Keypair.generate();

    const baseToken = await setupTestToken(connection, payerKeypair, takerKeypair.publicKey, makerPubkeyFromEnv, baseMintKeypair);
    const quoteToken = await setupTestToken(connection, payerKeypair, takerKeypair.publicKey, makerPubkeyFromEnv, quoteMintKeypair);
    console.log('');

    // Step 0.3: Maker Pre-Approves PDA for Token Delegation
    console.log('Step 0.3: Maker Pre-Approves PDA for Token Delegation');
    const [rfqAuthorityPda] = findPdaAddress([Buffer.from(RFQ_AUTHORITY_SEED)], PROGRAM_ID);

    const baseAmount = 100_000_000;
    const quoteAmountValue = 200_000_000;

    const approveIx = createApproveInstruction(
        quoteToken.makerAta,
        rfqAuthorityPda,
        makerPubkeyFromEnv,
        BigInt(quoteAmountValue)
    );

    const approvalTx = new Transaction().add(approveIx);
    const { blockhash: approvalBlockhash } = await connection.getLatestBlockhash();
    approvalTx.recentBlockhash = approvalBlockhash;
    approvalTx.feePayer = makerPubkeyFromEnv;
    approvalTx.sign(makerKeypair);

    console.log(`  [Approval] Sending approval transaction...`);
    const approvalSignature = await sendAndConfirmTransaction(connection, approvalTx, [makerKeypair], { skipPreflight: true });

    console.log(`  [Approval] Maker Quote ATA: ${quoteToken.makerAta.toBase58()}`);
    console.log(`  [Approval] Delegating allowance to PDA: ${rfqAuthorityPda.toBase58()}`);
    console.log(`  [Approval] Amount: ${quoteAmountValue}`);
    console.log(`  [Approval] Signature: ${approvalSignature}`);

    const tokenAccount = await connection.getParsedAccountInfo(quoteToken.makerAta);
    const parsedInfo = (tokenAccount.value?.data as any)?.parsed?.info;
    if (parsedInfo?.delegate) {
        console.log(`  [Approval] ✓ Delegation verified: ${parsedInfo.delegate}`);
        console.log(`  [Approval] ✓ Delegated amount: ${parsedInfo.tokenAmount.uiAmount}`);
    }
    console.log('');

    // Step 1: Request Firm Quote from Rust Backend API
    console.log('Step 1: Request Firm Quote from Aggregator Backend');

    const requestPayload = {
        baseToken: baseMintKeypair.publicKey.toBase58(),
        quoteToken: quoteMintKeypair.publicKey.toBase58(),
        side: "BUY",
        amount: baseAmount.toString(),
        taker: takerKeypair.publicKey.toBase58()
    };

    console.log(`  [Quote] Requesting quote from backend...`);
    console.log(`  [Quote] Base Token: ${requestPayload.baseToken}`);
    console.log(`  [Quote] Quote Token: ${requestPayload.quoteToken}`);
    console.log(`  [Quote] Amount: ${requestPayload.amount}`);
    console.log(`  [Quote] Taker: ${requestPayload.taker}`);

    let firmQuote: any;
    try {
        const response = await fetch(`${AGGREGATOR_ENDPOINT}/firm-quote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload)
        });

        if (!response.ok) {
            throw new Error(`Backend returned ${response.status}: ${await response.text()}`);
        }

        firmQuote = await response.json();
    } catch (error) {
        console.error('[Quote] Failed to get firm quote from backend:', error);
        process.exit(1);
    }

    console.log(`  ✓ Received Firm Quote from Backend:`);
    console.log(`  [Quote] RFQ ID: ${firmQuote.rfqId}`);
    console.log(`  [Quote] Price: ${firmQuote.price}`);
    console.log(`  [Quote] Amount: ${firmQuote.amount}`);
    console.log(`  [Quote] Expiry: ${new Date(firmQuote.expiry * 1000).toISOString()}`);
    console.log(`  [Quote] Maker: ${firmQuote.maker}`);
    console.log(`  [Quote] Signature (Base58): ${firmQuote.signature}`);

    const rfqIdBytes = hexToBytes(firmQuote.rfqId);
    const quoteAmount = new BN(firmQuote.amount);
    const expiry = firmQuote.expiry;
    const signatureBytes = bs58.decode(firmQuote.signature);

    const messageStr = [
        firmQuote.rfqId,
        requestPayload.baseToken,
        requestPayload.quoteToken,
        baseAmount.toString(),
        firmQuote.amount,
        expiry.toString(),
        requestPayload.taker
    ].join('|');
    const message = new TextEncoder().encode(messageStr);

    console.log(`  [Quote] Sign Message: ${messageStr}\n`);

    // Step 2: Taker/Aggregator Assembles Atomic Settlement Transaction
    console.log('Step 2: Taker/Aggregator Assembles Atomic Settlement Transaction');

    const [rfqRecordPda] = findPdaAddress(
        [Buffer.from(RFQ_RECORD_SEED), Buffer.from(rfqIdBytes)],
        PROGRAM_ID
    );

    console.log(`  [Assembly] RFQ Record PDA: ${rfqRecordPda.toBase58()}`);
    console.log(`  [Assembly] RFQ Authority PDA: ${rfqAuthorityPda.toBase58()}`);

    const transaction = new Transaction();

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: makerPubkeyFromEnv.toBytes(),
        message: message,
        signature: signatureBytes,
    });
    transaction.add(ed25519Ix);
    console.log('  [Assembly] Added Ed25519 signature verification instruction');

    const discriminator = crypto
        .createHash('sha256')
        .update('global:execute_trade')
        .digest()
        .subarray(0, 8);

    const rfqIdBuffer = Buffer.from(rfqIdBytes);
    const baseAmountBuffer = new BN(baseAmount).toArrayLike(Buffer, 'le', 8);
    const quoteAmountBuffer = quoteAmount.toArrayLike(Buffer, 'le', 8);
    const expiryBuffer = Buffer.alloc(8);
    expiryBuffer.writeBigInt64LE(BigInt(expiry), 0);
    const msgBytesBuffer = Buffer.from(message);
    const msgBytesLengthBuffer = Buffer.alloc(4);
    msgBytesLengthBuffer.writeUInt32LE(msgBytesBuffer.length, 0);

    const executeTradeData = Buffer.concat([
        discriminator, rfqIdBuffer, baseAmountBuffer, quoteAmountBuffer,
        expiryBuffer, msgBytesLengthBuffer, msgBytesBuffer
    ]);

    const executeTradeIx = {
        programId: PROGRAM_ID,
        keys: [
            { pubkey: takerKeypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: makerPubkeyFromEnv, isSigner: false, isWritable: false },
            { pubkey: rfqRecordPda, isSigner: false, isWritable: true },
            { pubkey: rfqAuthorityPda, isSigner: false, isWritable: false },
            { pubkey: baseToken.takerAta, isSigner: false, isWritable: true },
            { pubkey: baseToken.makerAta, isSigner: false, isWritable: true },
            { pubkey: quoteToken.makerAta, isSigner: false, isWritable: true },
            { pubkey: quoteToken.takerAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: executeTradeData,
    };

    transaction.add(executeTradeIx);
    console.log('  [Assembly] Added execute_trade instruction');

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = takerKeypair.publicKey;

    // Step 3: Submit and Confirm On-Chain Settlement
    console.log('\nStep 3: Submit and Confirm On-Chain Settlement');

    transaction.sign(takerKeypair);
    console.log(`  [Settlement] Transaction signed by Taker`);
    console.log(`  [Settlement] Transaction size: ${transaction.serialize().length} bytes`);

    const signature_str = await sendAndConfirmTransaction(
        connection,
        transaction,
        [takerKeypair],
        { skipPreflight: true, preflightCommitment: 'confirmed', commitment: 'confirmed' }
    );

    console.log(`  [Settlement] Transaction confirmed on-chain!`);
    console.log(`  [Settlement] Transaction Signature: ${signature_str}`);
    console.log(`  [Settlement] Explorer: https://explorer.solana.com/tx/${signature_str}?cluster=custom&customUrl=${RPC_ENDPOINT}`);

    // Post-Settlement Verification
    console.log('\n=== Post-Settlement Verification ===');

    const rfqRecordInfo = await connection.getAccountInfo(rfqRecordPda);
    if (rfqRecordInfo) {
        console.log('[Verification] RFQ Record PDA successfully initialized');
        console.log(`[Verification] PDA data size: ${rfqRecordInfo.data.length} bytes`);
    } else {
        console.log('[Verification] RFQ Record PDA initialization FAILED');
    }

    const takerBaseBalance = await connection.getTokenAccountBalance(baseToken.takerAta);
    const makerBaseBalance = await connection.getTokenAccountBalance(baseToken.makerAta);
    const takerQuoteBalance = await connection.getTokenAccountBalance(quoteToken.takerAta);
    const makerQuoteBalance = await connection.getTokenAccountBalance(quoteToken.makerAta);

    console.log('\n[Verification] Post-Settlement Token Balances:');
    console.log(`  Taker Base Token: ${takerBaseBalance.value.uiAmount}`);
    console.log(`  Maker Base Token: ${makerBaseBalance.value.uiAmount}`);
    console.log(`  Taker Quote Token: ${takerQuoteBalance.value.uiAmount}`);
    console.log(`  Maker Quote Token: ${makerQuoteBalance.value.uiAmount}`);

    console.log('\n=== RFQ E2E Test Suite Complete ===');
}

runRfqTest().catch(console.error);
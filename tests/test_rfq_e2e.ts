import * as crypto from 'crypto';

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
import * as nacl from 'tweetnacl';
import { v4 as uuidv4 } from 'uuid';
import bs58 from 'bs58';

// ========== Configuration Constants ==========
const PROGRAM_ID = new PublicKey('G29y9AUmrm3CwSifUbPMbUWmqLBKhjUcTCekYLtnegxG');
const RPC_ENDPOINT = 'http://127.0.0.1:8899'; // Local validator node
const RFQ_RECORD_SEED = 'rfq_record';
const RFQ_AUTHORITY_SEED = 'rfq_authority';

// ========== Utility Functions ==========

/**
 * Builds the message to be signed by the maker.
 * Serializes order parameters into Uint8Array format: rfqId|baseMint|quoteMint|baseAmount|quoteAmount|expiry|takerPubkey
 */
function buildSignMessage(params: {
    rfqId: Uint8Array;
    baseMint: string;
    quoteMint: string;
    baseAmount: BN;
    quoteAmount: BN;
    expiry: number;
    takerPubkey: string;
}): Uint8Array {
    const { rfqId, baseMint, quoteMint, baseAmount, quoteAmount, expiry, takerPubkey } = params;

    // Join all fields with '|' delimiter
    const messageStr = [
        bytesToHex(rfqId),
        baseMint,
        quoteMint,
        baseAmount.toString(),
        quoteAmount.toString(),
        expiry.toString(),
        takerPubkey,
    ].join('|');

    return new TextEncoder().encode(messageStr);
}

/**
 * Converts Uint8Array to hexadecimal string.
 */
function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Converts UUID string to 16-byte Uint8Array.
 */
function uuidToBytes(uuid: string): Uint8Array {
    const hex = uuid.replace(/-/g, '');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

/**
 * Derives PDA address from seeds and program ID.
 */
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

    // 1. Create Mint account
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
        9, // decimals
        payer.publicKey,
        payer.publicKey
    );

    // 2. Create Associated Token Accounts
    const takerAta = await getAssociatedTokenAddress(mintKeypair.publicKey, taker, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const makerAta = await getAssociatedTokenAddress(mintKeypair.publicKey, maker, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    const createTakerAtaIx = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        takerAta,
        taker,
        mintKeypair.publicKey
    );

    const createMakerAtaIx = createAssociatedTokenAccountInstruction(
        payer.publicKey,
        makerAta,
        maker,
        mintKeypair.publicKey
    );

    // 3. Mint tokens to Taker and Maker
    const mintToTakerIx = createMintToInstruction(
        mintKeypair.publicKey,
        takerAta,
        payer.publicKey,
        1_000_000_000 // 1 billion units
    );

    const mintToMakerIx = createMintToInstruction(
        mintKeypair.publicKey,
        makerAta,
        payer.publicKey,
        1_000_000_000
    );

    const tx = new Transaction().add(
        createMintAccountIx,
        initMintIx,
        createTakerAtaIx,
        createMakerAtaIx,
        mintToTakerIx,
        mintToMakerIx
    );

    await sendAndConfirmTransaction(connection, tx, [payer, mintKeypair], { skipPreflight: true });

    console.log(`  [TokenSetup] Taker ATA: ${takerAta.toBase58()}`);
    console.log(`  [TokenSetup] Maker ATA: ${makerAta.toBase58()}`);

    return { mint: mintKeypair.publicKey, takerAta, makerAta };
}

// ========== Main Test Function ==========

async function runRfqTest() {
    console.log('=== Solana RFQ End-to-End Test Suite ===\n');

    // Connect to local validator
    const connection = new Connection(RPC_ENDPOINT, 'confirmed');

    // Verify connection
    try {
        const version = await connection.getVersion();
        console.log(`[Connection] Connected to Solana node: ${version['solana-core']}\n`);
    } catch (error) {
        console.error('[Connection] Failed to connect to Solana node. Ensure local validator is running.');
        console.error('[Connection] Run: solana-test-validator');
        process.exit(1);
    }

    // ========== Step 0: Initialize Test Keypairs ==========
    console.log('Step 0: Initialize Test Keypairs');

    // Generate fresh keypairs for isolated test execution
    const takerKeypair = Keypair.generate();
    const makerKeypair = Keypair.generate();
    const payerKeypair = Keypair.generate(); // Fee payer for initialization transactions

    // Airdrop SOL to test accounts
    console.log('  [KeyGen] Provisioning SOL to test accounts...');
    const airdropPromises = [takerKeypair.publicKey, makerKeypair.publicKey, payerKeypair.publicKey].map(
        pk => connection.requestAirdrop(pk, 10 * LAMPORTS_PER_SOL)
    );
    await Promise.all(airdropPromises);
    console.log(`  [KeyGen] Taker: ${takerKeypair.publicKey.toBase58()}`);
    console.log(`  [KeyGen] Maker: ${makerKeypair.publicKey.toBase58()}`);
    console.log(`  [KeyGen] Payer: ${payerKeypair.publicKey.toBase58()}\n`);

    // ========== Step 0.1: Provision Mock Token Infrastructure ==========
    console.log('Step 0.1: Provision Mock Token Infrastructure');

    const baseMintKeypair = Keypair.generate();
    const quoteMintKeypair = Keypair.generate();

    const baseToken = await setupTestToken(connection, payerKeypair, takerKeypair.publicKey, makerKeypair.publicKey, baseMintKeypair);
    const quoteToken = await setupTestToken(connection, payerKeypair, takerKeypair.publicKey, makerKeypair.publicKey, quoteMintKeypair);

    console.log('');

    // ========== Step 0.2: Maker Pre-Approves PDA for Token Delegation ==========
    console.log('Step 0.2: Maker Pre-Approves PDA for Token Delegation');
    const [rfqAuthorityPda] = findPdaAddress(
        [Buffer.from(RFQ_AUTHORITY_SEED)],
        PROGRAM_ID
    );

    // Maker must pre-approve rfqAuthorityPDA to spend their Quote Tokens
    const approveIx = createApproveInstruction(
        quoteToken.makerAta,      // Source token account
        rfqAuthorityPda,          // Delegate authority (PDA)
        makerKeypair.publicKey,   // Token account owner (Maker)
        BigInt(200_000_000)       // Delegation amount (must match or exceed quoteAmount)
    );

    const setupTx = new Transaction().add(approveIx);
    await sendAndConfirmTransaction(connection, setupTx, [makerKeypair], { skipPreflight: true });
    console.log(`  [Approval] Maker delegated Quote Token allowance to PDA: ${rfqAuthorityPda.toBase58()}\n`);

    // ========================================================================
    // ZERO-SLIPPAGE RFQ FLOW FOR HIGH-VALUE RWA
    // Designed for tokenized assets (e.g., Ondo tokenized stocks, tokenized
    // US Treasuries) where exact price execution is critical. The RFQ
    // mechanism ensures zero slippage by locking the exchange rate
    // off-chain before on-chain settlement.
    // ========================================================================

    // ========== Step 1: Maker Generates Offline Quote & Cryptographic Signature ==========
    console.log('Step 1: Maker Generates Offline Quote & Cryptographic Signature');

    // RFQ order parameters
    const rfqId = uuidToBytes(uuidv4());
    const baseAmount = new BN(100_000_000); // 100 million units (10^8)
    const quoteAmount = new BN(200_000_000); // 200 million units
    // Strict 40-second expiry limit per OKX DEX specs
    const expiry = Math.floor(Date.now() / 1000) + 40;

    console.log(`  [Quote] RFQ ID: ${bytesToHex(rfqId)}`);
    console.log(`  [Quote] Base Token (SOL): ${baseMintKeypair.publicKey.toBase58()}`);
    console.log(`  [Quote] Quote Token (USDC): ${quoteMintKeypair.publicKey.toBase58()}`);
    console.log(`  [Quote] Base Amount: ${baseAmount.toString()}`);
    console.log(`  [Quote] Quote Amount: ${quoteAmount.toString()}`);
    console.log(`  [Quote] Expiry: ${new Date(expiry * 1000).toISOString()}`);
    console.log(`  [Quote] Taker: ${takerKeypair.publicKey.toBase58()}`);

    // Build message for cryptographic signing
    const message = buildSignMessage({
        rfqId,
        baseMint: baseMintKeypair.publicKey.toBase58(),
        quoteMint: quoteMintKeypair.publicKey.toBase58(),
        baseAmount,
        quoteAmount,
        expiry,
        takerPubkey: takerKeypair.publicKey.toBase58(),
    });

    console.log(`  [Quote] Sign Message: ${new TextDecoder().decode(message)}`);

    // Maker signs the message with their private key
    const signature = nacl.sign.detached(message, makerKeypair.secretKey);
    // Solana signatures must be Base58 encoded per OKX specs
    console.log(`  [Quote] Signature (Base58): ${bs58.encode(signature)}\n`);

    // ========================================================================
    // AGGREGATOR ASSEMBLY: RFQ Aggregator constructs the atomic settlement
    // transaction. This ensures that the Maker's off-chain quote is
    // cryptographically bound to the on-chain execution, preventing any
    // front-running or MEV extraction on high-value RWA trades.
    // ========================================================================

    // ========== Step 2: Taker/Aggregator Assembles Atomic Settlement Transaction ==========
    console.log('Step 2: Taker/Aggregator Assembles Atomic Settlement Transaction');

    // Derive PDA addresses for RFQ state accounts
    const [rfqRecordPda] = findPdaAddress(
        [Buffer.from(RFQ_RECORD_SEED), Buffer.from(rfqId)],
        PROGRAM_ID
    );

    console.log(`  [Assembly] RFQ Record PDA: ${rfqRecordPda.toBase58()}`);
    console.log(`  [Assembly] RFQ Authority PDA: ${rfqAuthorityPda.toBase58()}`);

    // Construct the settlement transaction
    const transaction = new Transaction();

    // Instruction 0: Ed25519 signature verification instruction via official Solana SDK
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
        publicKey: makerKeypair.publicKey.toBytes(),
        message: message,
        signature: signature,
    });
    transaction.add(ed25519Ix);
    console.log('  [Assembly] Added Ed25519 signature verification instruction');

    // Instruction 1: execute_trade instruction
    // Manually construct Anchor instruction data for deterministic serialization
    // 1. Method discriminator (8 bytes)
    const discriminator = crypto
        .createHash('sha256')
        .update('global:execute_trade')
        .digest()
        .subarray(0, 8);
    // 2. Serialize parameters
    const rfqIdBuffer = Buffer.from(rfqId);                           // 16 bytes
    const baseAmountBuffer = baseAmount.toArrayLike(Buffer, 'le', 8); // 8 bytes (u64 Little Endian)
    const quoteAmountBuffer = quoteAmount.toArrayLike(Buffer, 'le', 8); // 8 bytes (u64 Little Endian)

    const expiryBuffer = Buffer.alloc(8);                             // 8 bytes (i64 Little Endian)
    expiryBuffer.writeBigInt64LE(BigInt(expiry), 0);

    const msgBytesBuffer = Buffer.from(message);                      // Variable length
    const msgBytesLengthBuffer = Buffer.alloc(4);                     // 4 bytes (String/Vec length prefix)
    msgBytesLengthBuffer.writeUInt32LE(msgBytesBuffer.length, 0);

    // 3. Concatenate buffers to construct instruction data
    const executeTradeData = Buffer.concat([
        discriminator,
        rfqIdBuffer,
        baseAmountBuffer,
        quoteAmountBuffer,
        expiryBuffer,
        msgBytesLengthBuffer,
        msgBytesBuffer
    ]);

    const executeTradeIx = {
        programId: PROGRAM_ID,
        keys: [
            // taker (Signer)
            { pubkey: takerKeypair.publicKey, isSigner: true, isWritable: true },
            // maker (Unchecked)
            { pubkey: makerKeypair.publicKey, isSigner: false, isWritable: false },
            // rfq_record (PDA, init)
            { pubkey: rfqRecordPda, isSigner: false, isWritable: true },
            // rfq_authority (PDA)
            { pubkey: rfqAuthorityPda, isSigner: false, isWritable: false },
            // taker_base_ata (TokenAccount)
            { pubkey: baseToken.takerAta, isSigner: false, isWritable: true },
            // maker_base_ata (TokenAccount)
            { pubkey: baseToken.makerAta, isSigner: false, isWritable: true },
            // maker_quote_ata (TokenAccount)
            { pubkey: quoteToken.makerAta, isSigner: false, isWritable: true },
            // taker_quote_ata (TokenAccount)
            { pubkey: quoteToken.takerAta, isSigner: false, isWritable: true },
            // token_program
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            // system_program
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            // ix_sysvar (SYSVAR_INSTRUCTIONS_PUBKEY)
            { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: executeTradeData,
    };

    transaction.add(executeTradeIx);
    console.log('  [Assembly] Added execute_trade instruction');

    // Set transaction parameters
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = takerKeypair.publicKey;

    // ========================================================================
    // ON-CHAIN SETTLEMENT: The transaction atomically settles the RFQ by:
    // 1. Verifying the Maker's off-chain signature (Ed25519 precompile)
    // 2. Transferring Base Tokens from Maker to Taker
    // 3. Transferring Quote Tokens from Taker to Maker via PDA delegation
    // 4. Initializing the RFQ Record PDA as an immutable audit trail
    // ========================================================================

    // ========== Step 3: Submit and Confirm On-Chain Settlement ==========
    console.log('\nStep 3: Submit and Confirm On-Chain Settlement');

    // Taker signs the transaction as the settlement initiator
    transaction.sign(takerKeypair);

    console.log(`  [Settlement] Transaction signed by Taker`);
    console.log(`  [Settlement] Transaction size: ${transaction.serialize().length} bytes`);

    // Submit transaction to the Solana cluster
    const signature_str = await sendAndConfirmTransaction(
        connection,
        transaction,
        [takerKeypair], // Only taker signs; maker signature is pre-verified off-chain
        {
            skipPreflight: true,
            preflightCommitment: 'confirmed',
            commitment: 'confirmed',
        }
    );

    console.log(`  [Settlement] Transaction confirmed on-chain!`);
    console.log(`  [Settlement] Transaction Signature: ${signature_str}`);
    console.log(`  [Settlement] Explorer: https://explorer.solana.com/tx/${signature_str}?cluster=custom&customUrl=${RPC_ENDPOINT}`);

    // ========== Post-Settlement Verification ==========
    console.log('\n=== Post-Settlement Verification ===');

    // Verify RFQ Record PDA was initialized
    const rfqRecordInfo = await connection.getAccountInfo(rfqRecordPda);
    if (rfqRecordInfo) {
        console.log('[Verification] RFQ Record PDA successfully initialized');
        console.log(`[Verification] PDA data size: ${rfqRecordInfo.data.length} bytes`);
    } else {
        console.log('[Verification] RFQ Record PDA initialization FAILED');
    }

    // Verify token balance changes post-settlement
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

// Execute the test suite
runRfqTest().catch(console.error);
import { stakeIsLocked } from '../../utils/staking-ledger-util';
import { injectable } from 'inversify';
import { IPayoutCalculator, PayoutDetails, PayoutTransaction } from './Model';
import { Block, Stake } from '../dataProvider/dataprovider-types';
import { KeyCommissionRate } from '../../configuration/Model';

@injectable()
export class PayoutCalculator implements IPayoutCalculator {
    async getPayouts(
        blocks: Block[],
        stakers: Stake[],
        totalStake: number,
        defaultCommissionRate: number,
        mfCommissionRate: number,
        o1CommissionRate: number,
        investorsCommissionRate: number,
        commissionRates: KeyCommissionRate,
        burnAddress: string,
        bpKeyMd5Hash: string,
        configuredMemo: string,
    ): Promise<
        [payoutJson: PayoutTransaction[], storePayout: PayoutDetails[], blocksIncluded: number[], totalPayout: number, totalToBurn: number]
    > {
        // Initialize some stuff
        const SUPERCHARGEDCOINBASE = 1440000000000;
        const REGULARCOINBASE = 720000000000;
        const blocksIncluded: number[] = [];
        const storePayout: PayoutDetails[] = [];
        let totalToBurn = 0;

        // for each block, calculate the effective stake of each staker
        blocks.forEach((block: Block) => {
            // Keep a log of all blocks we processed
            blocksIncluded.push(block.blockheight);

            if (typeof block.coinbase === 'undefined' || block.coinbase == 0) {
                // no coinbase, don't need to do anything
            } else {
                const winner = this.getWinner(stakers, block);
                const winnerStakeIsLocked = stakeIsLocked(winner, block);
                const burnSuperChargedRewards =
                    block.coinbase == SUPERCHARGEDCOINBASE &&
                    (winner.shareClass.shareOwner == 'MF' || winner.shareClass.shareOwner == 'INVEST');
                let sumEffectiveCommonPoolStakes = 0;
                let sumEffectiveNPSPoolStakes = 0;
                const effectivePoolStakes: {
                    [key: string]: { npsStake: number; commonStake: number };
                } = {};

                const transactionFees = block.usercommandtransactionfees || 0;
                const totalRewards = block.coinbase + block.feetransfertoreceiver - block.feetransferfromcoinbase;
                const totalNPSPoolRewards = winnerStakeIsLocked ? block.coinbase : REGULARCOINBASE;
                // 20231201 implement new MF rules to burn supercharged rewards
                const burnAmount = burnSuperChargedRewards ? REGULARCOINBASE : 0;
                const totalCommonPoolRewards = totalRewards - totalNPSPoolRewards - burnAmount;
                totalToBurn += burnAmount;

                // Determine the supercharged discount for the block
                //  unlocked accounts will get a double share less this discount based on the ratio of fees : coinbase
                //  unlocked accounts generate extra coinbase, but if fees are significant, that coinbase would have a lower relative weight
                // 20231231 adding guard for transaction fees > coinbase so that supercharged weight doesn't get out of control. See upstream issue #103.
                const superchargedWeightingDiscount =
                    transactionFees >= block.coinbase ? 1 : transactionFees / block.coinbase;

                let totalUnweightedCommonStake = 0;
                // Determine the non-participating and common pool weighting for each staker
                stakers.forEach((staker: Stake) => {
                    const effectiveNPSStake = staker.stakingBalance;
                    let effectiveCommonStake = 0;
                    // common stake stays at 0 for NPS shares - they do not participate with the common in fees or supercharged block coinbase
                    if (staker.shareClass.shareClass == 'Common') {
                        effectiveCommonStake =
                            !stakeIsLocked(staker, block) && !burnSuperChargedRewards
                                ? staker.stakingBalance * (2 - superchargedWeightingDiscount)
                                : staker.stakingBalance;
                        totalUnweightedCommonStake += staker.stakingBalance;
                    }
                    sumEffectiveNPSPoolStakes += effectiveNPSStake;
                    sumEffectiveCommonPoolStakes += effectiveCommonStake;
                    effectivePoolStakes[staker.publicKey] = {
                        npsStake: effectiveNPSStake,
                        commonStake: effectiveCommonStake,
                    };
                });

                // Sense check the effective pool stakes must be at least equal to total_staking_balance and less than 2x
                if (sumEffectiveNPSPoolStakes != totalStake) {
                    throw new Error('NPS Share must be equal to total staked amount');
                }
                if (sumEffectiveCommonPoolStakes > totalUnweightedCommonStake * 2) {
                    throw new Error('Common weighted share must not be greater than 2x total common stake');
                }

                stakers.forEach((staker: Stake) => {
                    const effectiveNPSPoolWeighting =
                        effectivePoolStakes[staker.publicKey].npsStake / sumEffectiveNPSPoolStakes;
                    const effectiveCommonPoolWeighting =
                        effectivePoolStakes[staker.publicKey].commonStake / sumEffectiveCommonPoolStakes;

                    //TODO APPLY NEW COMMISSION RATES Extract function
                    const commissionRate = commissionRates[staker.publicKey]
                        ? commissionRates[staker.publicKey].commissionRate
                        : defaultCommissionRate;

                    let blockTotal = 0;
                    if (staker.shareClass.shareClass == 'Common') {
                        blockTotal =
                            Math.floor((1 - commissionRate) * totalNPSPoolRewards * effectiveNPSPoolWeighting) +
                            Math.floor((1 - commissionRate) * totalCommonPoolRewards * effectiveCommonPoolWeighting);
                    } else if (staker.shareClass.shareClass == 'NPS') {
                        if (staker.shareClass.shareOwner == 'MF') {
                            blockTotal = Math.floor(
                                (1 - mfCommissionRate) * totalNPSPoolRewards * effectiveNPSPoolWeighting,
                            );
                        } else if (staker.shareClass.shareOwner == 'O1') {
                            blockTotal = Math.floor(
                                (1 - o1CommissionRate) * totalNPSPoolRewards * effectiveNPSPoolWeighting,
                            );
                        } else if (staker.shareClass.shareOwner == 'INVEST') {
                            blockTotal = Math.floor(
                                (1 - investorsCommissionRate) * totalNPSPoolRewards * effectiveNPSPoolWeighting,
                            );
                        } else {
                            throw new Error(
                                'NPS shares should be MF or O1 or INVEST. Found NPS Shares with other owner.',
                            );
                        }
                    } else {
                        throw new Error(
                            'Shares should be common or non-participating. Found shares with other shareClass.',
                        );
                    }

                    staker.total += blockTotal;

                    // Store this data in a structured format for later querying and for the payment script, handled seperately
                    storePayout.push({
                        publicKey: staker.publicKey,
                        owner: staker.shareClass.shareOwner,
                        blockHeight: block.blockheight,
                        globalSlot: block.globalslotsincegenesis,
                        publicKeyUntimedAfter: staker.untimedAfterSlot,
                        winnerShareOwner: winner.shareClass.shareOwner,
                        shareClass: staker.shareClass,
                        stateHash: block.statehash,
                        stakingBalance: staker.stakingBalance,
                        effectiveNPSPoolWeighting: effectiveNPSPoolWeighting,
                        effectiveNPSPoolStakes: effectivePoolStakes[staker.publicKey].npsStake,
                        effectiveCommonPoolWeighting: effectiveCommonPoolWeighting,
                        effectiveCommonPoolStakes: effectivePoolStakes[staker.publicKey].commonStake,
                        sumEffectiveNPSPoolStakes: sumEffectiveNPSPoolStakes,
                        sumEffectiveCommonPoolStakes: sumEffectiveCommonPoolStakes,
                        superchargedWeightingDiscount: superchargedWeightingDiscount,
                        dateTime: block.blockdatetime,
                        coinbase: block.coinbase,
                        totalRewards: totalRewards,
                        totalRewardsToBurn: 0,
                        totalRewardsNPSPool: totalNPSPoolRewards,
                        totalRewardsCommonPool: totalCommonPoolRewards,
                        payout: blockTotal,
                        isEffectiveSuperCharge: false,
                        effectiveSuperchargedPoolWeighting: 0,
                        effectiveSuperchargedPoolStakes: 0,
                        sumEffectiveSuperchargedPoolStakes: 0,
                        totalRewardsSuperchargedPool: 0,
                    });
                });
                if (burnAmount > 0) {
                    storePayout.push({
                        publicKey: burnAddress,
                        owner: 'BURN',
                        blockHeight: block.blockheight,
                        globalSlot: block.globalslotsincegenesis,
                        publicKeyUntimedAfter: 0,
                        winnerShareOwner: winner.shareClass.shareOwner,
                        shareClass: { shareClass: 'BURN', shareOwner: 'BURN' },
                        stateHash: block.statehash,
                        stakingBalance: 0,
                        effectiveNPSPoolWeighting: 0,
                        effectiveNPSPoolStakes: 0,
                        effectiveCommonPoolWeighting: 0,
                        effectiveCommonPoolStakes: 0,
                        sumEffectiveNPSPoolStakes: 0,
                        sumEffectiveCommonPoolStakes: 0,
                        superchargedWeightingDiscount: 0,
                        dateTime: block.blockdatetime,
                        coinbase: 0,
                        totalRewards: 0,
                        totalRewardsToBurn: burnAmount,
                        totalRewardsNPSPool: 0,
                        totalRewardsCommonPool: 0,
                        payout: 0,
                        isEffectiveSuperCharge: false,
                        effectiveSuperchargedPoolWeighting: 0,
                        effectiveSuperchargedPoolStakes: 0,
                        sumEffectiveSuperchargedPoolStakes: 0,
                        totalRewardsSuperchargedPool: 0,
                    });
                }
            }
        });

        const payoutJson: PayoutTransaction[] = [];
        let totalPayout = 0;
        stakers.forEach((staker: Stake) => {
            const amount = staker.total;
            if (amount > 0) {
                payoutJson.push({
                    publicKey: staker.publicKey,
                    amount: amount,
                    fee: 0,
                    amountMina: 0,
                    feeMina: 0,
                    memo:
                        staker.shareClass.shareOwner === 'MF' || staker.shareClass.shareOwner === 'INVEST'
                            ? bpKeyMd5Hash
                            : configuredMemo,
                });
                totalPayout += amount;
            }
        });

        if (totalToBurn > 0) {
            payoutJson.push({
                publicKey: burnAddress,
                amount: totalToBurn,
                fee: 0,
                amountMina: 0,
                feeMina: 0,
                memo: bpKeyMd5Hash,
            });
        }

        return [payoutJson, storePayout, blocksIncluded, totalPayout, totalToBurn];
    }

    private getWinner(stakers: Stake[], block: Block): Stake {
        const winners = stakers.filter((x) => x.publicKey == block.winnerpublickey);
        if (winners.length != 1) {
            throw new Error('Should have exactly 1 winner.');
        }
        return winners[0];
    }
}

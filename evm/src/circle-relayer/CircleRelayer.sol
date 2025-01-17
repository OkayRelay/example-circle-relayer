// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../libraries/BytesLib.sol";

import {IWormhole} from "../interfaces/IWormhole.sol";

import "./CircleRelayerGovernance.sol";
import "./CircleRelayerMessages.sol";

/**
 * @title Circle Bridge Asset Relayer Example
 * @notice This example contract composes on Wormhole's Circle Integration contracts to faciliate
 * one-click transfers of Circle Bridge supported assets cross chain.
 */
contract CircleRelayer is CircleRelayerMessages, CircleRelayerGovernance, ReentrancyGuard {
    using BytesLib for bytes;

    /**
     * @notice Calls Wormhole's Circle Integration contract to burn user specified tokens.
     * It emits a Wormhole message with instructions for how to handle relayer payments
     * on the target contract and the quantity of tokens to convert into native assets
     * for the user.
     * @param token Address of the Circle Bridge asset to be transferred.
     * @param amount Quantity of tokens to be transferred.
     * @param toNativeTokenAmount Amount of tokens to swap into native assets on
     * the target chain.
     * @param targetChain Wormhole chain ID of the target blockchain.
     * @param targetRecipientWallet User's wallet address on the target blockchain.
     * @return messageSequence Wormhole sequence for emitted TransferTokensWithRelay message.
     */
    function transferTokensWithRelay(
        address token,
        uint256 amount,
        uint256 toNativeTokenAmount,
        uint16 targetChain,
        bytes32 targetRecipientWallet
    ) public payable nonReentrant returns (uint64 messageSequence) {
        // cache circle integration instance
        ICircleIntegration integration = circleIntegration();

        // check to see if token is accepted by the circle integration contract
        require(integration.isAcceptedToken(token), "token not accepted");

        // confirm that the user sent enough value to cover wormhole's message fee
        require(msg.value == wormhole().messageFee(), "insufficient value");

        // transfer the token to this contract
        uint256 amountReceived = custodyTokens(token, amount);
        uint256 targetRelayerFee = relayerFee(targetChain, token);
        require(
            amountReceived > targetRelayerFee + toNativeTokenAmount,
            "insufficient amountReceived"
        );

        // Construct additional instructions to tell the receiving contract
        // how to handle the token redemption.
        TransferTokensWithRelay memory transferMessage = TransferTokensWithRelay({
            payloadId: 1,
            targetRelayerFee: targetRelayerFee,
            toNativeTokenAmount: toNativeTokenAmount,
            targetRecipientWallet: targetRecipientWallet
        });

        // approve the circle integration contract to spend tokens
        SafeERC20.safeApprove(
            IERC20(token),
            address(integration),
            amountReceived
        );

        // transfer the tokens with instructions via the circle integration contract
        messageSequence = integration.transferTokensWithPayload(
            ICircleIntegration.TransferParameters({
                token: token,
                amount: amount,
                targetChain: targetChain,
                mintRecipient: getRegisteredContract(targetChain)
            }),
            0, // batchId = 0 to opt out of batching
            encodeTransferTokensWithRelay(transferMessage)
        );
    }

    /**
     * @notice Calls Wormhole's Circle Integration contract to complete the token transfer. Takes
     * custody of the minted tokens and sends the tokens to the target recipient.
     * It pays the relayer in the minted token denomination. If requested by the user,
     * it will perform a swap with the off-chain relayer to provide the user with native assets.
     * @param redeemParams Struct containing an attested Wormhole message, Circle Bridge message,
     * and Circle transfer attestation.
     */
    function redeemTokens(
        ICircleIntegration.RedeemParameters memory redeemParams
    ) public payable nonReentrant {
        // cache circle integration instance
        ICircleIntegration integration = circleIntegration();

        // mint USDC to this contract
        ICircleIntegration.DepositWithPayload memory deposit = 
            integration.redeemTokensWithPayload(redeemParams);

        // parse the additional instructions from the deposit message
        TransferTokensWithRelay memory transferMessage = decodeTransferTokensWithRelay(
            deposit.payload
        );

        // verify that the sender is a registered contract
        require(
            deposit.fromAddress == getRegisteredContract(
                integration.getChainIdFromDomain(deposit.sourceDomain)
            ),
            "fromAddress is not a registered contract"
        );

        // cache the token and recipient addresses
        address token = bytes32ToAddress(deposit.token);
        address recipient = bytes32ToAddress(transferMessage.targetRecipientWallet);

        // handle native asset payments and refunds
        if (transferMessage.toNativeTokenAmount > 0) {
            /**
             * Compute the maximum amount of tokens that the user is allowed
             * to swap for native assets.
             *
             * Override the toNativeTokenAmount in the transferMessage if
             * the toNativeTokenAmount is greater than the maxToNativeAllowed.
             *
             * Compute the amount of native assets to send the recipient.
             */
            uint256 nativeAmountForRecipient;
            uint256 maxToNativeAllowed = calculateMaxSwapAmount(token);
            if (transferMessage.toNativeTokenAmount > maxToNativeAllowed) {
                transferMessage.toNativeTokenAmount = maxToNativeAllowed;
                nativeAmountForRecipient = maxSwapAmount(token);
            } else {
                // compute amount of native asset to pay the recipient
                nativeAmountForRecipient = calculateNativeSwapAmount(
                    token,
                    transferMessage.toNativeTokenAmount
                );
            }

            /**
             * The nativeAmountForRecipient can be zero if the user specifed a toNativeTokenAmount
             * that is too little to convert to native asset. We need to override the toNativeTokenAmount
             * to be zero if that is the case, that way the user receives the full amount of minted USDC.
             */
            if (nativeAmountForRecipient > 0) {
                // check to see if the relayer sent enough value
                require(
                    msg.value >= nativeAmountForRecipient,
                    "insufficient native asset amount"
                );

                // refund excess native asset to relayer if applicable
                uint256 relayerRefund = msg.value - nativeAmountForRecipient;
                if (relayerRefund > 0) {
                    payable(msg.sender).transfer(relayerRefund);
                }

                // send requested native asset to target recipient
                payable(recipient).transfer(nativeAmountForRecipient);
            } else {
                // override the toNativeTokenAmount in the transferMessage
                transferMessage.toNativeTokenAmount = 0;

                // refund the relayer any native asset sent to this contract
                if (msg.value > 0) {
                    payable(msg.sender).transfer(msg.value);
                }
            }
        }

        /**
         * Override the relayerFee if the encoded targetRelayerFee is less
         * than the relayer fee set on this chain. This should only happen
         * if relayer fees are not syncronized across all chains.
         */
        uint256 relayerFee = relayerFee(chainId(), token);
        if (relayerFee > transferMessage.targetRelayerFee) {
            relayerFee = transferMessage.targetRelayerFee;
        }

        // pay the relayer in the minted token denomination
        SafeERC20.safeTransfer(
            IERC20(token),
            msg.sender,
            relayerFee + transferMessage.toNativeTokenAmount
        );

        // pay the target recipient the remaining minted tokens
        SafeERC20.safeTransfer(
            IERC20(token),
            recipient,
            deposit.amount - relayerFee - transferMessage.toNativeTokenAmount
        );
    }

    /**
     * @notice Calculates the max amount of tokens the user can convert to
     * native assets on this chain.
     * @dev The max amount of native assets the contract will swap with the user
     * is governed by the `maxSwapAmount` state variable.
     * @param token Address of token being transferred.
     * @return maxAllowed The maximum number of tokens the user is allowed to
     * swap for native assets.
     */
    function calculateMaxSwapAmount(
        address token
    ) public view returns (uint256 maxAllowed) {
        maxAllowed =
            (maxSwapAmount(token) * nativeSwapRate(token)) /
            (10 ** (18 - tokenDecimals(token)) * nativeSwapRatePrecision());
    }

    /**
     * @notice Calculates the amount of native assets that a user will receive
     * when swapping transferred tokens for native assets.
     * @dev The swap rate is governed by the `nativeSwapRate` state variable.
     * @param token Address of token being transferred.
     * @param toNativeAmount Quantity of tokens to be converted to native assets.
     * @return nativeAmount The exchange rate between native assets and the `toNativeAmount`
     * of transferred tokens.
     */
    function calculateNativeSwapAmount(
        address token,
        uint256 toNativeAmount
    ) public view returns (uint256 nativeAmount) {
        nativeAmount =
            nativeSwapRatePrecision() * toNativeAmount /
            nativeSwapRate(token) * 10 ** (18 - tokenDecimals(token));
    }

    function tokenDecimals(address token) internal view returns (uint8) {
        // fetch the token decimals
        (,bytes memory queriedDecimals) = token.staticcall(
            abi.encodeWithSignature("decimals()")
        );
        return abi.decode(queriedDecimals, (uint8));
    }

    function custodyTokens(address token, uint256 amount) internal returns (uint256) {
        // query own token balance before transfer
        (,bytes memory queriedBalanceBefore) = token.staticcall(
            abi.encodeWithSelector(IERC20.balanceOf.selector,
            address(this))
        );
        uint256 balanceBefore = abi.decode(queriedBalanceBefore, (uint256));

        // deposit USDC
        SafeERC20.safeTransferFrom(
            IERC20(token),
            msg.sender,
            address(this),
            amount
        );

        // query own token balance after transfer
        (,bytes memory queriedBalanceAfter) = token.staticcall(
            abi.encodeWithSelector(IERC20.balanceOf.selector,
            address(this))
        );
        uint256 balanceAfter = abi.decode(queriedBalanceAfter, (uint256));

        // this check is necessary since Circle's token contracts are upgradeable
        return balanceAfter - balanceBefore;
    }

    function bytes32ToAddress(bytes32 address_) public pure returns (address) {
        return address(uint160(uint256(address_)));
    }
}

import debug from "debug";

import {
  correctSelectors,
  createSourcesModelFromAst,
} from "@nomicfoundation/edr";
import {
  CompilerInput,
  CompilerOutput,
  CompilerOutputBytecode,
} from "../../../types";

import {
  getLibraryAddressPositions,
  normalizeCompilerOutputBytecode,
} from "./library-utils";
import { Bytecode, Contract, CustomError, SourceFile } from "./model";
import { decodeInstructions } from "./source-maps";

const log = debug("hardhat:core:hardhat-network:compiler-to-model");

export function createModelsAndDecodeBytecodes(
  solcVersion: string,
  compilerInput: CompilerInput,
  compilerOutput: CompilerOutput
): Bytecode[] {
  const fileIdToSourceFile = new Map<number, SourceFile>();
  const contractIdToContract = new Map<number, Contract>();

  createSourcesModelFromAst(
    compilerOutput,
    compilerInput,
    fileIdToSourceFile,
    contractIdToContract
  );

  const bytecodes = decodeBytecodes(
    solcVersion,
    compilerOutput,
    fileIdToSourceFile,
    contractIdToContract
  );

  correctSelectors(bytecodes, compilerOutput);

  return bytecodes;
}

function decodeBytecodes(
  solcVersion: string,
  compilerOutput: CompilerOutput,
  fileIdToSourceFile: Map<number, SourceFile>,
  contractIdToContract: Map<number, Contract>
): Bytecode[] {
  const bytecodes: Bytecode[] = [];

  for (const contract of contractIdToContract.values()) {
    const contractFile = contract.location.file.sourceName;
    const contractEvmOutput =
      compilerOutput.contracts[contractFile][contract.name].evm;
    const contractAbiOutput =
      compilerOutput.contracts[contractFile][contract.name].abi;

    for (const abiItem of contractAbiOutput) {
      if (abiItem.type === "error") {
        const customError = CustomError.fromABI(abiItem.name, abiItem.inputs);

        if (customError !== undefined) {
          contract.addCustomError(customError);
        } else {
          log(`Couldn't build CustomError for error '${abiItem.name}'`);
        }
      }
    }

    // This is an abstract contract
    if (contractEvmOutput.bytecode.object === "") {
      continue;
    }

    const deploymentBytecode = decodeEvmBytecode(
      contract,
      solcVersion,
      true,
      contractEvmOutput.bytecode,
      fileIdToSourceFile
    );

    const runtimeBytecode = decodeEvmBytecode(
      contract,
      solcVersion,
      false,
      contractEvmOutput.deployedBytecode,
      fileIdToSourceFile
    );

    bytecodes.push(deploymentBytecode);
    bytecodes.push(runtimeBytecode);
  }

  return bytecodes;
}

function decodeEvmBytecode(
  contract: Contract,
  solcVersion: string,
  isDeployment: boolean,
  compilerBytecode: CompilerOutputBytecode,
  fileIdToSourceFile: Map<number, SourceFile>
): Bytecode {
  const libraryAddressPositions = getLibraryAddressPositions(compilerBytecode);

  const immutableReferences =
    compilerBytecode.immutableReferences !== undefined
      ? Object.values(compilerBytecode.immutableReferences).reduce(
          (previousValue, currentValue) => [...previousValue, ...currentValue],
          []
        )
      : [];

  const normalizedCode = normalizeCompilerOutputBytecode(
    compilerBytecode.object,
    libraryAddressPositions
  );

  const instructions = decodeInstructions(
    normalizedCode,
    compilerBytecode.sourceMap,
    fileIdToSourceFile,
    isDeployment
  );

  return new Bytecode(
    contract,
    isDeployment,
    normalizedCode,
    instructions,
    libraryAddressPositions,
    immutableReferences,
    solcVersion
  );
}

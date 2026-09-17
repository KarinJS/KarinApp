import {requireNativeComponent, ViewProps} from 'react-native';

type Props = ViewProps & {
  sourceNativeID: string;
  blurRadius: number;
};

export default requireNativeComponent<Props>('KarinGlassView');

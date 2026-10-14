import styles from "./Button.module.css";

type ButtonProps = { onClick: () => void; children?: unknown };

export const Button = ({ onClick, children }: ButtonProps) => (
  <button className={styles.button} onClick={onClick}>
    {children}
  </button>
);
